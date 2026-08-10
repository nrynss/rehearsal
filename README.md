# Rehearsal

**Paste a job posting. Get interviewed on it.**

Rehearsal scrapes the posting, the company behind it, and what has been written about them
recently — then briefs you on what to study, interviews you aloud about that specific role,
and scores your answers against what it found.

Live at **[rehearsal.nryn.dev](https://rehearsal.nryn.dev)**. No account required.

---

## The problem

Interview prep is generic in a way the interview never is.

People rehearse against lists — *tell me about yourself*, *what's your greatest weakness* —
then walk into a room where the questions are about **this** posting, at **this** company,
which shipped something notable last month. That gap is where interviews are lost.

The strange part is that the specifics are public. The posting names the responsibilities and
the years of experience. The company profile names the size, the industry, the headquarters.
The news says what just happened. Three public documents, freely available, and almost nobody
works through them systematically the night before — because doing it properly takes an hour
and you don't know which parts matter.

## What it does

The app is a workspace with three peer tabs, not a linear flow.

**Research** — paste a LinkedIn job URL. Three live scrapes run in front of you, each landing
as a card with its source domain and a timestamp: the posting, the company profile, recent
news. Beneath them, a prep brief — what the company does, what the role actually owns, what to
study — with every claim citing the card it came from.

**Rehearse** — one hiring manager, drawn with a name and a voice, introduces themselves and
asks up to eight questions, aloud. You answer out loud (ninety seconds each) or you type. Each
question is grounded in a specific line of the research, and the brief's *"angles they're
likely to push on"* section is the specification the question generator works from — so the
interview probes what the brief told you it would.

**Relive** — a verdict, then per question: your transcript, rubric scores, the key points you
missed, a model answer, and the research card the question came from.

**With a resume saved**, every posting also gains a **fit match**: what you already have, what
the posting asks for that you have not evidenced, and what to study first, ordered by the
biggest gap. The interview then aims roughly a third of its questions at those gaps rather
than at the posting in general.

## Why it is not a chatbot with a prompt

Every question is traceable to a line in scraped data, and the app shows you the line.

Against a real posting — Principal QA Engineer (Playwright) at Deltek — the generated set
included a question built from a press release about a workforce reduction and a partnership
announcement, asking how the candidate would deliver more coverage with fewer resources. Not
"tell me about a time you worked under pressure." The company's actual quarter, turned into
the question a hiring manager would really ask.

The scoring is honest in the same direction. It will tell you that your content averaged 1 out
of 5 and name the fifteen key points you missed. A session where most questions were skipped
can never read as ready, however well the few answers scored.

---

## Architecture

```
Browser (Vite + React + TypeScript)
   │
   │  every vendor call, always
   ▼
Supabase Edge Functions (Deno)  ── keyed proxy: no API key ever reaches the browser
   │
   ├── Bright Data      job posting · company profile · news (SERP)
   ├── Speechmatics     TTS (the interviewer's voice) · batch STT (your answers)
   └── Featherless      prep brief · questions · fit match · scoring · opening
```

**Supabase is a keyed proxy and a small amount of storage — not a backend.** Edge functions
exist so API keys never reach the browser and the browser never negotiates CORS with an API
that does not offer it. There is no key-entry UI anywhere in the app, and there never will be.

Two tables only:

| table | contents |
|---|---|
| `research_cache` | Shared, non-personal research keyed by URL — scrapes, news, prep briefs. Readable by any signed-in user, which is why nothing personal is ever written to it. |
| `resumes` | One row per user, own-row RLS, `on delete cascade` from `auth.users`. Deleted after 30 days without activity by a `pg_cron` job. |

Interview sessions live **in memory for one page load**. Relive is empty after a refresh, by
design — cross-session history needs real accounts and is deliberately out of scope.

### The model chain

All runtime inference is **Featherless**, via a shared two-model chain
(`supabase/functions/_shared/featherless.ts`):

1. `deepseek-ai/DeepSeek-V4-Flash-0731` — primary
2. `deepseek-ai/DeepSeek-V4-Flash` — fallback when the primary errors or returns nothing

`FEATHERLESS_MODEL` overrides the primary only, so an override experiment cannot take the whole
chain down. The function logs which model answered, so a silent downgrade is visible.

### Audio

**Out:** `speechmatics-tts` returns a WAV; the browser plays it from a blob URL. A generation
counter in `src/lib/audio.ts` guarantees only one question can ever be speaking — a fetch that
resolves after being superseded is discarded rather than played.

**In:** `MediaRecorder` produces whatever container the browser supports (usually WebM), which
is then **converted client-side to 16 kHz mono 16-bit PCM WAV** before upload. This is not
optional: Speechmatics does not accept WebM, and every recording was rejected until the
conversion was added. A failed transcription offers three exits — retry the upload, type the
answer instead, or record again — and a scoring failure falls back to a deterministic rubric
rather than losing the answer.

## Privacy

- **Your resume is yours.** Stored against your account so it follows you between browsers,
  never shared, deletable at any time, and removed after 30 days without activity.
- **Nothing personal is cached server-side.** The fit match, the resume-targeted question set
  and the resume-derived opening greeting are all generated, returned and forgotten —
  `research_cache` is readable by every signed-in user, so anything about a person stays out
  of it.
- **Recordings never leave your browser** except as the audio sent for transcription. They are
  held in memory for playback and download during the session.
- **No analytics, no advertising, no third-party storage.** The only things kept in the browser
  are the auth session and a flag recording that you dismissed the intro — which is why there
  is no cookie banner.
- Sign-in is optional. GitHub, Discord or email; anonymous sessions are upgraded **in place**
  via `linkIdentity()`, so a resume saved before signing up is still yours afterwards.

## How it was built

Built with **[native.builder](https://native.builder)** for the AI Factory hackathon, with
**AI/ML API** as the model behind Builder.

The working method was deliberate and worth describing, because it shaped the codebase:

- **Specs and prompts live outside the repo.** Feature work reached the app as written
  prompts pasted into Builder chat, one coherent change at a time. Large multi-feature prompts
  produce broken results; small ones do not.
- **Edge functions were edited and deployed directly** via the Supabase CLI when a change was
  small, security-relevant, or needed verifying against a live call.
- **Verification is against raw responses, never UI state.** The most expensive failures on
  this project all *rendered as success* — a card reading "Ready" over an empty record, a
  green test suite over a transcription path that had never once worked. Fixes were confirmed
  by reading the deployed function source and the actual API response, not the screen.

## Running it locally

Requires Node 20+.

```bash
npm install
npm run dev
```

| script | does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | production build |
| `npm run preview` | serve the production build |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |

The app talks to the deployed Supabase project, so a local run needs the Supabase URL and
anon key in the environment. **No vendor API keys are needed locally** — they live only as
Supabase secrets and are never present in the client.

### Edge functions

```bash
supabase functions deploy <name> --project-ref <ref>
```

Secrets required in the Supabase project: `BRIGHTDATA_API_KEY`, `BRIGHTDATA_SERP_ZONE`,
`SPEECHMATICS_API_KEY`, `FEATHERLESS_API_KEY`. Optionally `FEATHERLESS_MODEL` and
`AIML_API_KEY`.

## Layout

```
src/
  components/   SplashScreen · Tabs · ResearchScreen · RehearseScreen · ReliveScreen
                ResumePanel · AccountPanel · Expander
  lib/          research · ai · audio · score · prep · resume · accounts · pdf · config
  test/         Vitest suites for every lib module and screen
supabase/
  functions/    brightdata-{jobs,company,news,status} · speechmatics-{tts,batch}
                ai-{brief,questions,score,fit,opening} · _shared/featherless
```

## Design

The reference is **the notebook of someone organised who is attending interviews** —
institutional, evidentiary, clinical. Expressed structurally, never decoratively: hairlines
instead of boxes, one 2px radius, no shadows anywhere, a fixed spacing scale, numbered entries
in a margin.

One rule matters more than the rest: **Signal red `#C8342B` means the microphone is live, and
nothing else.** Not errors, not validation, not destructive buttons. If red is on screen, you
are being recorded. Failures read through weight and contrast instead.

## External APIs and tools

| | used for |
|---|---|
| **Bright Data** | LinkedIn job posting, company profile, and news (SERP) — the grounding the product depends on |
| **Speechmatics** | Text-to-speech for the interviewer, batch speech-to-text for answers |
| **Featherless** | Prep brief, question generation, fit match, answer scoring, opening greeting |
| **Supabase** | Edge functions, anonymous and OAuth auth, two tables |
| **native.builder** | The platform this was built on |
| **AI/ML API** | The model behind Builder during development |

## Status and known gaps

Built in a week as a hackathon project. Honest about what it is not:

- **Accounts carry your resume, not your history.** Signing in keeps a stable identity so your
  resume follows you between browsers — but interview sessions are React state only. Finish a
  rehearsal, refresh, and Relive is empty whether you are signed in or not. Persisting sessions
  needs a `sessions` table with row-scoped RLS and a decision about storing recordings; both
  were deliberately out of scope for the week.
- Openings and resume-targeted question sets are not rate limited, because the limiter counted
  cache rows that are deliberately no longer written. A proper fix needs a rate-limit table
  that is not world-readable.
- The Speechmatics proxy functions do not check the caller.
- Selecting a different posting while questions are still generating can leave the previous
  posting's questions loaded.
