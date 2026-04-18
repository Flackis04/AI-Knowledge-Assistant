import test from "node:test";
import assert from "node:assert/strict";
import { createChunks, createExtractiveAnswer, findRelevantChunks, tokenize } from "../src/textTools.js";

test("tokenize normalizes Swedish question words and removes common stop words", () => {
  assert.deepEqual(tokenize("Vad säger materialet om AI och lärande?"), ["sager", "materialet", "ai", "larande"]);
});

test("createChunks splits longer text into searchable chunks", () => {
  const text = Array.from({ length: 420 }, (_, index) => `ord${index}`).join(" ");
  const chunks = createChunks(text);

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].id, "chunk-1");
});

test("findRelevantChunks returns the chunk that best matches the question", () => {
  const documents = [
    {
      id: "doc-1",
      title: "Maskininlärning",
      sourceType: "text",
      createdAt: "2026-04-18T00:00:00.000Z",
      chunks: createChunks("Neurala nätverk använder lager för att hitta mönster i data. Trädgårdsskötsel handlar om jord och vatten.")
    }
  ];

  const results = findRelevantChunks(documents, "Hur hittar neurala nätverk mönster?", 1);

  assert.equal(results.length, 1);
  assert.match(results[0].snippet, /Neurala nätverk/);
});

test("createExtractiveAnswer stays grounded in supplied sources", () => {
  const answer = createExtractiveAnswer("Vad gör neurala nätverk?", [
    {
      title: "AI-notering",
      text: "Neurala nätverk använder lager för att hitta mönster i data.",
      snippet: "Neurala nätverk använder lager för att hitta mönster i data."
    }
  ]);

  assert.match(answer, /Neurala nätverk/);
  assert.match(answer, /AI-notering/);
});
