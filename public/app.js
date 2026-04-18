const uploadForm = document.querySelector("#uploadForm");
const askForm = document.querySelector("#askForm");
const titleInput = document.querySelector("#titleInput");
const documentInput = document.querySelector("#documentInput");
const textInput = document.querySelector("#textInput");
const questionInput = document.querySelector("#questionInput");
const uploadStatus = document.querySelector("#uploadStatus");
const answerOutput = document.querySelector("#answerOutput");
const sourcesOutput = document.querySelector("#sourcesOutput");
const documentList = document.querySelector("#documentList");

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Sparar innehåll ...");

  const formData = new FormData();
  const file = documentInput.files[0];

  formData.append("title", titleInput.value.trim());
  formData.append("text", textInput.value.trim());

  if (file) {
    formData.append("document", file);
  }

  if (!file && textInput.value.trim().length === 0) {
    setStatus("Välj en fil eller klistra in text.", true);
    return;
  }

  setBusy(uploadForm, true);

  try {
    const result = await request("/api/upload", {
      method: "POST",
      body: formData
    });

    setStatus(`Sparat: ${result.document.title}`);
    uploadForm.reset();
    await loadDocuments();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(uploadForm, false);
  }
});

askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();

  if (!question) {
    return;
  }

  answerOutput.textContent = "Söker i materialet ...";
  sourcesOutput.innerHTML = "";
  setBusy(askForm, true);

  try {
    const result = await request("/api/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ question })
    });

    answerOutput.textContent = result.warning ? `${result.answer}\n\n${result.warning}` : result.answer;
    renderSources(result.sources || []);
  } catch (error) {
    answerOutput.textContent = error.message;
  } finally {
    setBusy(askForm, false);
  }
});

documentList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-document]");

  if (!button) {
    return;
  }

  button.disabled = true;

  try {
    await request(`/api/documents/${button.dataset.deleteDocument}`, { method: "DELETE" });
    await loadDocuments();
  } catch (error) {
    button.textContent = error.message;
  }
});

await loadDocuments();

async function loadDocuments() {
  try {
    const result = await request("/api/documents");
    renderDocuments(result.documents || []);
  } catch (error) {
    documentList.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function renderDocuments(documents) {
  if (documents.length === 0) {
    documentList.innerHTML = '<p class="empty">Inget sparat innehåll ännu.</p>';
    return;
  }

  documentList.innerHTML = documents
    .map(
      (document) => `
        <article class="document-item">
          <strong>${escapeHtml(document.title)}</strong>
          <p>${escapeHtml(document.fileName || document.sourceType)}</p>
          <div class="document-meta">
            <span class="tag">${formatNumber(document.charCount)} tecken</span>
            <span class="tag">${formatNumber(document.chunkCount)} textdelar</span>
          </div>
          <button class="delete-button" type="button" data-delete-document="${document.id}">Ta bort</button>
        </article>
      `
    )
    .join("");
}

function renderSources(sources) {
  if (sources.length === 0) {
    sourcesOutput.innerHTML = '<p class="empty">Ingen relevant källa hittades.</p>';
    return;
  }

  sourcesOutput.innerHTML = sources
    .map(
      (source) => `
        <article class="source-item">
          <strong>${escapeHtml(source.title)}</strong>
          <p>${escapeHtml(source.snippet)}</p>
          <div class="document-meta">
            <span class="tag">match ${Math.round(source.score * 100)}%</span>
            <span class="tag">del ${source.chunkIndex + 1}</span>
          </div>
        </article>
      `
    )
    .join("");
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Förfrågan misslyckades.");
  }

  return payload;
}

function setStatus(message, isError = false) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("error", isError);
}

function setBusy(form, isBusy) {
  for (const button of form.querySelectorAll("button")) {
    button.disabled = isBusy;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("sv-SE").format(value || 0);
}
