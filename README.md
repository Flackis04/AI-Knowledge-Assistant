# AI Knowledge Assistant

En liten lokal webbapp där användaren kan ladda upp text eller PDF, spara innehållet, ställa frågor och få svar baserade på de relevanta delarna av materialet.

## Kör appen

```bash
npm start
```

Öppna sedan `http://localhost:3000`.

Vill du ändra port eller host:

```bash
PORT=3001 HOST=127.0.0.1 npm start
```

## AI-svar

Skapa en lokal `.env` eller exportera miljövariabler innan du startar servern:

```bash
export OPENAI_API_KEY="din_nyckel"
export OPENAI_MODEL="gpt-4.1-mini"
npm start
```

Om `OPENAI_API_KEY` saknas använder appen en lokal fallback som plockar ut de mest relevanta meningarna från materialet.

## PDF-stöd

Servern använder `pdftotext` om det finns installerat. Det finns en enkel fallback för okomprimerade PDF-strängar, men riktig PDF-extraktion blir bäst med Poppler:

```bash
sudo apt install poppler-utils
```

## Data

Uppladdade dokument och extraherad text sparas lokalt i `data/`. Den katalogen ignoreras av git så användarmaterial inte hamnar i versionshantering.

## Kommandon

```bash
npm test
npm run dev
```
