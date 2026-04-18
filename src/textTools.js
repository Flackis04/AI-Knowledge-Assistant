const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "av",
  "att",
  "be",
  "but",
  "by",
  "can",
  "de",
  "den",
  "det",
  "du",
  "eller",
  "en",
  "ett",
  "for",
  "fran",
  "from",
  "ha",
  "har",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "med",
  "men",
  "not",
  "of",
  "om",
  "on",
  "or",
  "och",
  "pa",
  "som",
  "that",
  "the",
  "this",
  "till",
  "to",
  "vad",
  "var",
  "was",
  "we",
  "with",
  "you"
]);

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function tokenize(value) {
  const matches = normalizeText(value).match(/[a-z0-9]+/g) || [];
  return matches.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function splitIntoChunks(text, options = {}) {
  const targetWords = options.targetWords || 180;
  const overlapWords = options.overlapWords || 35;
  const cleaned = cleanText(text);

  if (!cleaned) {
    return [];
  }

  const units = cleaned
    .split(/(?<=[.!?])\s+|\n{2,}/u)
    .map((unit) => unit.trim())
    .filter(Boolean);

  const chunks = [];
  let current = [];
  let currentWordCount = 0;

  for (const unit of units) {
    const words = unit.split(/\s+/).filter(Boolean);

    if (words.length > targetWords) {
      if (current.length > 0) {
        chunks.push(current.join(" "));
        current = [];
        currentWordCount = 0;
      }

      for (let index = 0; index < words.length; index += targetWords - overlapWords) {
        chunks.push(words.slice(index, index + targetWords).join(" "));
      }

      continue;
    }

    if (currentWordCount + words.length > targetWords && current.length > 0) {
      const previousWords = current.join(" ").split(/\s+/).filter(Boolean);
      const overlap = previousWords.slice(-overlapWords).join(" ");
      chunks.push(current.join(" "));
      current = overlap ? [overlap, unit] : [unit];
      currentWordCount = current.join(" ").split(/\s+/).filter(Boolean).length;
      continue;
    }

    current.push(unit);
    currentWordCount += words.length;
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

export function createChunks(text) {
  return splitIntoChunks(text).map((chunk, index) => ({
    id: `chunk-${index + 1}`,
    index,
    text: chunk
  }));
}

export function findRelevantChunks(documents, question, limit = 5) {
  const queryTokens = tokenize(question);

  if (queryTokens.length === 0) {
    return [];
  }

  const chunks = documents.flatMap((document) =>
    (document.chunks || []).map((chunk) => ({
      documentId: document.id,
      title: document.title,
      fileName: document.fileName,
      sourceType: document.sourceType,
      createdAt: document.createdAt,
      chunkId: chunk.id,
      chunkIndex: chunk.index,
      text: chunk.text
    }))
  );

  if (chunks.length === 0) {
    return [];
  }

  const chunkTermFrequencies = chunks.map((chunk) => termFrequency(tokenize(chunk.text)));
  const documentFrequency = new Map();

  for (const frequencies of chunkTermFrequencies) {
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const queryFrequency = termFrequency(queryTokens);
  const totalChunks = chunks.length;
  const queryNorm = vectorNorm(queryFrequency, documentFrequency, totalChunks) || 1;

  return chunks
    .map((chunk, index) => {
      const chunkFrequency = chunkTermFrequencies[index];
      const chunkNorm = vectorNorm(chunkFrequency, documentFrequency, totalChunks) || 1;
      const score = cosineScore(queryFrequency, chunkFrequency, documentFrequency, totalChunks, queryNorm, chunkNorm);
      const titleBonus = titleMatchesQuestion(chunk.title, queryTokens) ? 0.04 : 0;

      return {
        ...chunk,
        score: score + titleBonus,
        snippet: createSnippet(chunk.text, queryTokens)
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function createExtractiveAnswer(question, sources) {
  if (sources.length === 0) {
    return "Jag hittade ingen tillräckligt relevant text i det sparade materialet. Lägg till mer innehåll eller formulera frågan mer specifikt.";
  }

  const queryTokens = tokenize(question);
  const sentences = sources.flatMap((source) =>
    splitSentences(source.text).map((sentence) => ({
      sentence,
      sourceTitle: source.title,
      score: sentenceScore(sentence, queryTokens)
    }))
  );

  const selected = uniqueBySentence(sentences)
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (selected.length === 0) {
    return `Jag hittade relevant material i "${sources[0].title}", men inte en tydlig mening som direkt besvarar frågan. Den bästa matchningen är: ${sources[0].snippet}`;
  }

  const evidence = selected.map((item) => `- ${item.sentence} (${item.sourceTitle})`).join("\n");
  return `Utifrån det sparade materialet pekar svaret på följande:\n\n${evidence}\n\nDet här är ett lokalt utdragssvar. Lägg till OPENAI_API_KEY för ett mer sammanhängande AI-svar som fortfarande håller sig till källtexten.`;
}

function termFrequency(tokens) {
  const frequency = new Map();

  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) || 0) + 1);
  }

  return frequency;
}

function inverseDocumentFrequency(token, documentFrequency, totalChunks) {
  return Math.log((1 + totalChunks) / (1 + (documentFrequency.get(token) || 0))) + 1;
}

function vectorNorm(frequency, documentFrequency, totalChunks) {
  let sum = 0;

  for (const [token, count] of frequency.entries()) {
    const weight = count * inverseDocumentFrequency(token, documentFrequency, totalChunks);
    sum += weight * weight;
  }

  return Math.sqrt(sum);
}

function cosineScore(queryFrequency, chunkFrequency, documentFrequency, totalChunks, queryNorm, chunkNorm) {
  let dotProduct = 0;

  for (const [token, queryCount] of queryFrequency.entries()) {
    const chunkCount = chunkFrequency.get(token) || 0;

    if (chunkCount === 0) {
      continue;
    }

    const idf = inverseDocumentFrequency(token, documentFrequency, totalChunks);
    dotProduct += queryCount * idf * chunkCount * idf;
  }

  return dotProduct / (queryNorm * chunkNorm);
}

function titleMatchesQuestion(title, queryTokens) {
  const titleTokens = new Set(tokenize(title));
  return queryTokens.some((token) => titleTokens.has(token));
}

function createSnippet(text, queryTokens) {
  const normalizedText = normalizeText(text);
  const firstMatchIndex = queryTokens
    .map((token) => normalizedText.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const start = Math.max(0, (firstMatchIndex || 0) - 160);
  const end = Math.min(text.length, start + 520);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";

  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function splitSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 24);
}

function sentenceScore(sentence, queryTokens) {
  const sentenceTokens = new Set(tokenize(sentence));
  return queryTokens.reduce((score, token) => score + (sentenceTokens.has(token) ? 1 : 0), 0);
}

function uniqueBySentence(items) {
  const seen = new Set();
  const unique = [];

  for (const item of items) {
    const key = normalizeText(item.sentence).slice(0, 120);

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return unique;
}
