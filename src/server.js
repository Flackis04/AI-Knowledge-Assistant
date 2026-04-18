import http from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanText, createChunks, createExtractiveAnswer, findRelevantChunks } from "./textTools.js";
import { extractPdfText } from "./pdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DOCUMENTS_FILE = path.join(DATA_DIR, "documents.json");

await loadEnvFile(path.join(ROOT_DIR, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;
const MAX_JSON_BYTES = 1 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

await ensureDataStore();

const server = http.createServer(async (req, res) => {
  try {
    await routeRequest(req, res);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Något gick fel på servern." : error.message;

    if (status === 500) {
      console.error(error);
    }

    sendJson(res, status, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Knowledge Assistant körs på http://${HOST}:${PORT}`);
});

async function routeRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/documents") {
    const documents = await readDocuments();
    sendJson(res, 200, { documents: documents.map(publicDocument) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/upload") {
    const document = await handleUpload(req);
    sendJson(res, 201, { document: publicDocument(document) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ask") {
    const result = await handleQuestion(req);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/documents/")) {
    const id = pathname.split("/").pop();
    await deleteDocument(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(pathname, res, req.method === "HEAD");
    return;
  }

  throw new HttpError(405, "Metoden stöds inte.");
}

async function handleUpload(req) {
  const parts = await parseMultipart(req);
  const id = randomUUID();
  const titlePart = getTextPart(parts, "title");
  const pastedText = getTextPart(parts, "text");
  const filePart = parts.find((part) => part.name === "document" && part.filename && part.data.length > 0);

  let text = "";
  let fileName = "";
  let sourceType = "text";

  if (filePart) {
    fileName = sanitizeFileName(filePart.filename);
    const extension = path.extname(fileName).toLowerCase();
    const storedFileName = `${id}${extension || ".bin"}`;
    const uploadPath = path.join(UPLOAD_DIR, storedFileName);

    await fs.writeFile(uploadPath, filePart.data);

    if (extension === ".pdf" || filePart.contentType === "application/pdf") {
      sourceType = "pdf";
      text = await extractPdfText(uploadPath, filePart.data);
    } else {
      sourceType = "text-file";
      text = decodeTextFile(filePart.data);
    }
  } else if (pastedText.trim().length > 0) {
    sourceType = "pasted-text";
    text = pastedText;
  } else {
    throw new HttpError(400, "Ladda upp en fil eller klistra in text.");
  }

  const cleaned = cleanText(text);

  if (cleaned.length < 20) {
    throw new HttpError(422, "Texten är för kort eller kunde inte läsas.");
  }

  const chunks = createChunks(cleaned);
  const documents = await readDocuments();
  const document = {
    id,
    title: normalizeTitle(titlePart, fileName),
    fileName,
    sourceType,
    createdAt: new Date().toISOString(),
    charCount: cleaned.length,
    chunkCount: chunks.length,
    text: cleaned,
    chunks
  };

  documents.unshift(document);
  await writeDocuments(documents);
  return document;
}

async function handleQuestion(req) {
  const body = await parseJson(req);
  const question = String(body.question || "").trim();

  if (question.length < 2) {
    throw new HttpError(400, "Skriv en fråga först.");
  }

  const documents = await readDocuments();

  if (documents.length === 0) {
    throw new HttpError(400, "Det finns inga sparade dokument ännu.");
  }

  const sources = findRelevantChunks(documents, question, 5);

  if (sources.length === 0) {
    return {
      answer: createExtractiveAnswer(question, []),
      mode: "local",
      sources: []
    };
  }

  const publicSources = sources.map(publicSource);
  let warning = "";

  try {
    const aiAnswer = await answerWithOpenAI(question, sources);

    if (aiAnswer) {
      return {
        answer: aiAnswer,
        mode: "openai",
        sources: publicSources
      };
    }
  } catch (error) {
    warning = `AI-anropet misslyckades, så ett lokalt svar visas i stället. ${error.message}`;
  }

  return {
    answer: createExtractiveAnswer(question, sources),
    mode: "local",
    warning,
    sources: publicSources
  };
}

async function answerWithOpenAI(question, sources) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return "";
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const context = sources
    .map((source, index) => `[${index + 1}] ${source.title}\n${source.text}`)
    .join("\n\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "Du är en AI Knowledge Assistant. Svara bara utifrån den källtext som skickas med. Om texten inte räcker ska du säga det tydligt. Svara på svenska och nämn källnummer när det hjälper."
        },
        {
          role: "user",
          content: `Fråga: ${question}\n\nKälltext:\n${context}`
        }
      ],
      temperature: 0.2,
      max_output_tokens: 800
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI svarade med ${response.status}: ${errorBody.slice(0, 240)}`);
  }

  const payload = await response.json();
  return extractOutputText(payload);
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") {
    return payload.output_text.trim();
  }

  const text = (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("")
    .trim();

  return text;
}

async function deleteDocument(id) {
  const documents = await readDocuments();
  const document = documents.find((item) => item.id === id);
  const remaining = documents.filter((item) => item.id !== id);

  if (!document) {
    throw new HttpError(404, "Dokumentet finns inte.");
  }

  await writeDocuments(remaining);

  if (document.fileName) {
    const extension = path.extname(document.fileName);
    const uploadPath = path.join(UPLOAD_DIR, `${document.id}${extension}`);
    await fs.rm(uploadPath, { force: true });
  }
}

async function serveStatic(pathname, res, headOnly) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    throw new HttpError(403, "Otillåten sökväg.");
  }

  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });

    if (!headOnly) {
      res.end(file);
    } else {
      res.end();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "Sidan finns inte.");
    }

    throw error;
  }
}

async function parseMultipart(req) {
  const contentTypeHeader = req.headers["content-type"] || "";
  const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

  if (!boundaryMatch) {
    throw new HttpError(400, "Förfrågan saknar multipart-boundary.");
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const parts = [];
  let position = body.indexOf(delimiter);

  while (position !== -1) {
    position += delimiter.length;

    if (body.slice(position, position + 2).toString() === "--") {
      break;
    }

    if (body.slice(position, position + 2).toString() === "\r\n") {
      position += 2;
    }

    const headerEnd = body.indexOf(headerSeparator, position);

    if (headerEnd === -1) {
      break;
    }

    const rawHeaders = body.slice(position, headerEnd).toString("utf8");
    const contentStart = headerEnd + headerSeparator.length;
    const nextBoundary = body.indexOf(delimiter, contentStart);

    if (nextBoundary === -1) {
      break;
    }

    let contentEnd = nextBoundary;

    if (body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    }

    const disposition = rawHeaders.match(/content-disposition:\s*([^\r\n]+)/i)?.[1] || "";
    const name = headerParameter(disposition, "name");
    const filename = headerParameter(disposition, "filename");
    const contentType = rawHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || "";

    if (name) {
      parts.push({
        name,
        filename,
        contentType,
        data: body.slice(contentStart, contentEnd)
      });
    }

    position = nextBoundary;
  }

  return parts;
}

async function parseJson(req) {
  const body = await readBody(req, MAX_JSON_BYTES);

  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Ogiltig JSON.");
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      total += chunk.length;

      if (total > limit && !settled) {
        settled = true;
        reject(new HttpError(413, "Förfrågan är för stor."));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function ensureDataStore() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  try {
    await fs.access(DOCUMENTS_FILE);
  } catch {
    await fs.writeFile(DOCUMENTS_FILE, "[]\n");
  }
}

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readDocuments() {
  await ensureDataStore();
  const raw = await fs.readFile(DOCUMENTS_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeDocuments(documents) {
  await fs.writeFile(DOCUMENTS_FILE, `${JSON.stringify(documents, null, 2)}\n`);
}

function publicDocument(document) {
  return {
    id: document.id,
    title: document.title,
    fileName: document.fileName,
    sourceType: document.sourceType,
    createdAt: document.createdAt,
    charCount: document.charCount,
    chunkCount: document.chunkCount
  };
}

function publicSource(source) {
  return {
    documentId: source.documentId,
    title: source.title,
    fileName: source.fileName,
    sourceType: source.sourceType,
    chunkId: source.chunkId,
    chunkIndex: source.chunkIndex,
    score: Number(source.score.toFixed(3)),
    snippet: source.snippet
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml; charset=utf-8"
    }[extension] || "application/octet-stream"
  );
}

function getTextPart(parts, name) {
  const part = parts.find((item) => item.name === name);
  return part ? part.data.toString("utf8").trim() : "";
}

function headerParameter(header, parameterName) {
  const match = header.match(new RegExp(`${parameterName}="([^"]*)"`, "i"));
  return match ? match[1] : "";
}

function sanitizeFileName(fileName) {
  return path.basename(fileName).replace(/[^\w.\- åäöÅÄÖ]/g, "_");
}

function normalizeTitle(title, fileName) {
  const fallback = fileName ? fileName.replace(/\.[^.]+$/, "") : "Inklistrad text";
  return (title || fallback).trim().slice(0, 120);
}

function decodeTextFile(buffer) {
  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;

  if (replacementCount > Math.max(8, utf8.length * 0.05)) {
    return buffer.toString("latin1");
  }

  return utf8;
}
