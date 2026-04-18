import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractPdfText(filePath, originalBuffer) {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", filePath, "-"], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 20000
    });

    if (stdout.trim().length > 0) {
      return stdout.trim();
    }
  } catch (error) {
    const fallback = extractReadablePdfStrings(originalBuffer);

    if (fallback.length > 0) {
      return fallback;
    }

    throw new Error(`PDF-text kunde inte extraheras: ${error.message}`);
  }

  const fallback = extractReadablePdfStrings(originalBuffer);

  if (fallback.length > 0) {
    return fallback;
  }

  throw new Error("PDF-text kunde inte extraheras.");
}

function extractReadablePdfStrings(buffer) {
  const raw = buffer.toString("latin1");
  const strings = [];
  const expression = /\((?:\\.|[^\\)]){3,}\)/g;
  let match;

  while ((match = expression.exec(raw)) !== null) {
    const value = decodePdfString(match[0].slice(1, -1));

    if (/[a-zA-ZåäöÅÄÖ]{3,}/.test(value)) {
      strings.push(value);
    }
  }

  return strings
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodePdfString(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
