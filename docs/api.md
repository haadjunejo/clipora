# REST API

Everything the website does goes through this API, so you can script Clipora or build another front end.
Interactive docs are served at **`/api/docs`**. When `APP_PASSWORD` is set, log in first with
`POST /api/login {"password": "..."}` (a session cookie is set).

## Projects
| Method | Path | What |
|---|---|---|
| POST | `/api/uploads/{id}` | form: `index`, `chunk` (and `size` on the first piece) — upload a big file in ≤50 MB pieces |
| POST | `/api/jobs` | form: `url`, or `upload_id` + `upload_name`; plus `options` (JSON) → new project |
| GET | `/api/jobs` | all projects (status, progress, clip counts, posts) |
| GET / DELETE | `/api/jobs/{id}` | one project with clips and log / delete it |
| POST | `/api/jobs/{id}/retry` | retry a failed project |
| GET | `/api/jobs/{id}/zip` | all clips + `clips.json` + `captions.txt` |
| GET | `/api/jobs/{id}/words` · `/waveform` · `/framing` | transcript words, audio peaks, face position (editor) |

**Project options** (all optional): `num_clips` (0 = auto, max 100), `min_sec`, `max_sec`, `language`,
`reframe` (`face` · `split` · `blur` · `center`), `crop_x`, `aspect` (`9:16` · `1:1` · `16:9`), `caption_style`
(`bold_yellow` · `karaoke` · `boxed` · `neon` · `minimal` · `none`), `caption_size`, `caption_position`,
`text_color`, `highlight_color`, `uppercase`, `words_per_line`, `show_hook`, `hook_seconds`, `hook_position`,
`remove_fillers`, `remove_silences`, `progress_bar`, `watermark`, `watermark_position`, `ai_prompt`,
`long_mode` (`auto` · `on` · `off`).

## Clips
| Method | Path | What |
|---|---|---|
| POST | `/api/jobs/{id}/clips/{n}` | edit: `start`, `end`, `cuts`, `title`, `hook`, `description`, `hashtags`, any style option; `render: true` re-renders |
| DELETE | `/api/jobs/{id}/clips/{n}` | delete a clip |
| POST | `/api/jobs/{id}/clips/{n}/publish` | `platforms` (`yt` · `ig` · `fb`), `title`, `description`, `hashtags`, `privacy`, `made_for_kids`, `publish_at` (ISO time) |
| GET | `/media/{id}/{file}` | clip files, posters, thumbnails (range requests supported) |

## Accounts, settings, AI
| Method | Path | What |
|---|---|---|
| GET | `/api/connections` | YouTube / Instagram / Facebook connection state |
| POST | `/api/connect/youtube/start` · `/finish` · `/disconnect` | Google sign-in (paste flow) |
| POST | `/api/connect/meta/start` · `/finish` · `/page` · `/refresh` · `/disconnect` | Facebook login |
| GET | `/api/analytics/youtube` · `/api/analytics/meta` | live views, likes, comments |
| GET / PUT | `/api/settings` | default project options, studio name |
| POST / DELETE | `/api/brand/logo` · `/api/cookies` | watermark logo · YouTube cookies.txt |
| GET / POST | `/api/storage` · `/api/storage/clean` | disk usage · delete old finished projects |
| POST | `/api/ai/rewrite` | AI title / hook / description / hashtags |
| GET | `/api/status` | GPU, AI providers (with rate-limit state), queue, settings |
