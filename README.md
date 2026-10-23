# Inkwell

An unrestricted front-end for any model on [OpenRouter](https://openrouter.ai), built for two things: **long-form writing** and **roleplay**. Lorebooks that work like SillyTavern's World Info (and import/export its files), book-sized source documents that are searched only when the lore doesn't cover something, a **live map** of the story world, and a **scene simplifier** that tells you what's going on in plain words.

Everything runs on your own computer. Your chats, lorebooks and documents are stored locally in SQLite.

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm run dev          # http://localhost:5180
```

Open **Settings**, paste your OpenRouter API key, and pick models (defaults are filled in). For everyday use: `npm run build && npm start`.

Data lives in `data/inkwell.db` (set `DATA_DIR` to move it). `PORT` changes the port. The app only accepts connections from your own computer because it spends your OpenRouter credits; set `HOST=0.0.0.0` if you deliberately want other devices on your network to reach it.

**Unrestricted:** Inkwell adds no filters, refusals or content warnings of its own, and its default system prompts tell the model to write whatever the story calls for. How far a reply goes depends on the model and provider you choose: open-weight models (DeepSeek, Llama, Mistral, Qwen, Hermes…) are the most permissive.

## The two modes

Every chat is either **Writing** or **Roleplay** (switchable in chat settings).

### ✍️ Writing

You talk to the AI in plain language and it helps you write: drafting, continuing, rewriting, brainstorming, critiquing.

- **System prompt:** a global writing prompt (Settings), plus each chat's own prompt for that project's voice, genre, point of view, tense and rules.
- **Manuscript panel:** your draft. Paste it in, edit it directly, or press **＋ Manuscript** on any AI reply. The AI always sees the end of it (size is configurable), so it continues in your voice. Export as `.md`.
- **Notes panel:** outline and story notes that are always in context.
- **Quick prompts:** one-click *Continue*, *Rewrite last*, *Brainstorm*, *Expand*, *Critique* (edit them in Settings; Shift-click to tweak before sending).
- **Lorebooks and documents:** see below.

### ⚔️ Roleplay

A narrator plays the world and every character except you.

- **Characters & personas:** import SillyTavern / Chub character cards (V1–V3, `.png` or `.json`), including alternate greetings (as swipes) and embedded lorebooks. Personas are who you play. Group scenes work: add several characters.
- **The map:** after every narrator reply, the *map keeper* (a cheap model) updates a structured map: places nested inside each other (region › area › building › floor › room), how they connect (doors, roads, stairs), and where every person and notable object is, including your outfit, inventory and condition. It's drawn live in the side panel:
  - Zoom into any place, follow your character with 📍, and click places or people for details.
  - **Go here** / **Approach** buttons write the action into your message box.
  - Drag places to rearrange them, or drag people into another room to correct the map. **Edit** anything by hand.
  - **GM view** reveals hidden people (the assassin in the rafters). They're hidden from you by default, and people whose name you don't know show as "the hooded stranger".
  - **Both the narrator and the map keeper always get the full map**, so the narrator knows where everyone is and who can see whom.
  - **Scene check:** right before the narrator writes, it gets a short computed list: who is in the same place as you (and can see and hear you), who is nearby but can't see you, who is out of earshot, the things in the room, and **what each nearby character knows about you**. Anything not listed, they don't know. This targets the two classic failures: losing track of where things are, and characters knowing or pointing out things they shouldn't.
  - **What characters know:** the map keeper records what each character learns about you on screen (your name, what you said, what they saw you do). See and edit it by clicking a person on the map.
- **The scene simplifier:** after every reply, a plain-words card. *Right now* (what's happening, in 1-3 short sentences), where you are, the time, who's around (only people you know of and should know of), what someone is waiting on you to answer, what you need to know, what you're wearing and carrying and your condition, and a few things you could do next (click to put one in the message box). Adjustable text size. The 💡 button also puts a one-line **In short** under every narrator message.
- **Rewinds correctly:** regenerating, swiping between versions, deleting messages and branching all bring the map and the scene card back to how they were at that point.
- **⏭ Move the story on** (or sending an empty message, or typing "continue"): when you have nothing to do, the narrator keeps your character doing what they were doing and moves time forward just enough to reach the next moment you can react to.
- **Write for me** (impersonate) drafts your next move for you to edit. **🎲 d20** rolls into your message.
- **The narrator's default rules:** it never writes your character's actions, words or thoughts; it plays scenes line by line and fights exchange by exchange, stopping wherever you'd react; "I swing at her" lets the world decide the outcome, while "I dodge it" is final.

## Lorebooks (World Info)

A lorebook entry is only sent to the AI when one of its keywords comes up, so you can have thousands of entries without paying for them on every message. Inkwell implements SillyTavern's World Info activation rules and imports/exports its files unchanged:

| Feature | |
|---|---|
| Keywords | whole-word matching, `/regex/flags` keys, case sensitivity per entry |
| Secondary keywords | AND ANY / AND ALL / NOT ANY / NOT ALL logic |
| Always-on entries, priority (order), trigger chance % | |
| Insertion position | before/after the definitions, with the author's note, or at a depth in the chat |
| Timed effects | sticky, cooldown, delay |
| Inclusion groups | weighted random, or "prioritize" by order |
| Recursion | entries trigger entries, with *non-recursable*, *prevent further recursion* and *delay until recursion* |
| Budgets | a global lore budget, per-book budgets, per-book scan depth, *ignore budget* |

What it does beyond SillyTavern:

- **Plurals and possessives match automatically:** `dragon` fires on "dragons", `Kael` on "Kael's", with Unicode-aware word boundaries.
- **Location-aware lore (roleplay):** the place you're standing in, the places around it, and the people present count as "mentioned", so walking into the Rusty Anchor loads its entry even if nobody said its name.
- **Manuscript-aware lore (writing):** the end of your manuscript is scanned too, so the characters in the current scene are loaded.
- **The chat's cast is always "mentioned"**, so their lore entries come along.
- **Per-mode entries:** an entry can be writing-only or roleplay-only.
- **Activation inspector:** the ⓘ on any reply (or the **Context** tab) shows exactly which entries fired and why (which keyword, sticky, recursion…), which were cut by the budget, and how the whole prompt was spent. **Preview next prompt** shows the exact messages the model will get.
- **Tester:** paste text into a lorebook's tester to see what fires.
- **Lore keeper:** reads the recent story and proposes new entries for characters, places and facts the story invented, for you to accept into a lorebook.
- **Compile documents into lorebooks:** a cheap model turns a document into dense, keyword-triggered entries (with sample dialogue for characters). **Estimate cost** first.

## Documents: book-sized context, only when needed

Upload books, wikis, series bibles or notes of any size (`.txt`, `.md`, `.docx`, `.pdf`, `.html`) under **Documents**, or straight from a chat's **Sources** tab. They're split into small passages and indexed for full-text search (SQLite FTS5 with BM25 ranking and stemming). **They're never sent whole.**

On each message, after the lorebooks have been activated, Inkwell decides whether the documents are needed. You choose how, per chat or globally:

- **Smart (default):** a cheap model reads the latest message and the lore that was loaded, and lists only the facts that are *missing*. Only those are searched for. If the lore covers it, nothing is pulled.
- **Free:** looks up names and terms that no loaded lore entry covers, with no extra AI call.
- **Always:** searches on every message. **Off:** never.

You can also search your documents yourself in the **Sources** tab and **📌 pin** passages so they're always in context.

## Everything else

- **Swipes:** regenerate keeps older versions. Arrow through them; swiping past the last one generates a new one.
- **Continue**, **Stop** (keeps what was written), **edit** any message, **delete** (Shift-click deletes everything after it too), **hide** a message from the AI without deleting it, **branch** a chat from any message.
- **🧭 Direct:** steer just the next reply ("the guard recognises me", "end on a cliffhanger") without it becoming part of the story.
- **OOC notes:** out-of-character messages the AI reads but treats as notes, not story.
- **Author's note** at a chosen depth, for the current tone or goal.
- **Rolling memory:** when a chat outgrows the context budget, older messages are folded into an editable summary in batches (cheap model), so long chats keep their history without huge prompts.
- **Thinking models:** reasoning is shown collapsed above the reply and never sent back.
- **Samplers:** temperature, top-p, min-p, top-k, frequency/presence/repetition penalty, max length, as global defaults with per-chat overrides. A model can be set per chat.
- **Macros:** `{{user}}`, `{{char}}`, `<USER>`, `<BOT>`, `{{random::a::b}}`, `{{roll:2d6}}`, `{{time}}`, `{{date}}`, `{{// comment}}`.
- **Output rules:** regex find & replace applied to every reply (strip phrases a model overuses).
- **Costs:** a usage page per task and per model, as reported by OpenRouter, and an optional **daily spending limit** that stops all AI calls once reached.
- **Export:** chats as Markdown or JSON, manuscripts as Markdown, lorebooks in SillyTavern format, characters as V2 cards (PNG with the card embedded if it has a picture). **Backup / restore** everything in one file (Settings).
- Light and dark themes, serif or sans prose, a resizable side panel, phone-friendly layout.

## What each message costs

| Call | Model | When |
|---|---|---|
| The reply | your writing / roleplay model | every message |
| Document check | utility | only in *Smart* mode, and only if the chat has documents |
| Map keeper | map keeper (default: utility) | roleplay, after each reply (can be turned off) |
| Scene simplifier | simplifier (default: utility) | roleplay, after each reply (can be turned off) |
| Memory summary | utility | every few turns, once a chat is longer than the context budget |

## Project layout

```
server/
  index.js       Express API, serves the client
  db.js          SQLite schema, settings, default system prompts
  openrouter.js  OpenRouter client (streaming, reasoning, samplers, JSON repair, usage & spend limit)
  lorebook.js    Lore entries, SillyTavern import/export, the activation engine, AI compile
  documents.js   Document indexing (FTS5), gap detection, retrieval
  context.js     Prompt assembly for both modes, macros, history fitting
  generate.js    Generation (reply / regenerate / continue / impersonate), swipes, memory, branching, lore keeper
  tracker.js     Roleplay map: operations, layout, text rendering, map keeper and scene simplifier
  files.js       Document text extraction, character cards (PNG/JSON read & write)
  backup.js      Full backup and restore
client/src/
  App.jsx        Layout, chat list, navigation
  views/         ChatView, ChatSettings, NewChat, Lorebooks, Characters, Documents, Settings, Usage
  panels/        MapPanel, ScenePanel, SourcesPanel, ContextPanel
test/            Engine tests: npm test
```
