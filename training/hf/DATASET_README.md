---
license: apache-2.0
language:
- en
task_categories:
- text-generation
tags:
- tool-calling
- function-calling
- synthetic
- music-production
- daw
size_categories:
- 1K<n<10K
configs:
- config_name: default
  data_files:
  - split: train
    path: data/train.jsonl
  - split: validation
    path: data/val.jsonl
---

# Gemma 4 Mixer Tool Calls

These are synthetic chat examples that teach a model to turn a music producer's request into tool calls for an
Ableton Live-style DAW. They were used to fine-tune
[ishaanjagyasi/gemma4-e4b-mixer-assistant](https://huggingface.co/ishaanjagyasi/gemma4-e4b-mixer-assistant).

Made for the University of Michigan course *Human-AI Interaction* (Fall 2026, Assignment 2). The generator code
is on GitHub: [ishaanjagyasi/gemma4-mixer-assistant](https://github.com/ishaanjagyasi/gemma4-mixer-assistant) (`dataset.js`, `gen.js`).

| Split | Examples | Tool calls | Seed |
|---|---|---|---|
| train | 3,000 | 11,417 | 7001 |
| validation | 300 | — | 9001 |

## Format

Each line is one example in OpenAI-style chat format, with the tools attached:

```json
{
  "messages": [
    {"role": "system", "content": "<the rules: how to read producer language, vague amounts, pan, sends ...>"},
    {"role": "user", "content": "Session:\nTempo 124 BPM. ...\n1. Kick [drums]: -6.0 dB, C, on | sends A -inf dB, B -inf dB | effects: ... | clips: ...\n...\n\nRequest: bring the kick down a touch and put a reverb on the snare"},
    {"role": "assistant", "content": "", "tool_calls": [
      {"type": "function", "function": {"name": "set_volume", "arguments": {"track": "Kick", "db": -1, "relative": true}}},
      {"type": "function", "function": {"name": "add_effect", "arguments": {"track": "Snare", "effect": "Reverb"}}}
    ]}
  ],
  "tools": [ /* the 24 tool schemas */ ]
}
```

These are the 24 tools:

| Area | Tools |
|---|---|
| Mixing | `set_volume`, `set_pan`, `set_mute`, `set_solo`, `set_arm`, `set_send` |
| Tracks | `insert_track`, `delete_track`, `duplicate_track`, `rename_track`, `set_track_color` |
| Effects | `add_effect`, `remove_effect`, `set_effect_on`, `set_effect_param` |
| Transport | `set_tempo`, `set_metronome`, `set_loop`, `play`, `stop`, `record` |
| Editing | `add_sample`, `delete_range`, `duplicate_range` |

The effects are EQ Eight, Auto Filter, Compressor, Saturator, Delay, Reverb and Utility.

## How it was generated

All examples come from a seeded program, so the same seed always produces the same data.

**Sessions.**
- Half use a fixed 8-track session: Kick, Snare, Hats, Bass, Keys, Pad, Lead Vox, Back Vox.
- Half use random sessions of 5–10 tracks drawn from 18 track types.
- Volumes, pans, sends, effects, effect parameters and clips are all random.

**Requests.** Each has 1–6 clauses, each a separate change.
- **Casual:** spoken, vague and slangy ("bring the kick up a touch", "kill the BVs", "more reverb on the snare").
- **Precise:** exact values and names ("set Lead Vox volume to -7.5 dB", "tempo 126.5 BPM").
- **How tracks are named:** by name or alias ("the hi-hats"), by number ("track 3"), or by group ("the drums").
- **Vague words have fixed meanings**, which the system prompt states: "a touch" = 1 dB, "a bit" = 2 dB, "a few" = 3 dB, "a lot" = 6 dB, "a little left" = 15L, "more reverb" = +3 dB send.
- About 15% of requests are written like speech transcripts: lower case, no punctuation.

**Answers.** The correct tool calls are generated together with the request.
- An example is kept only if every clause changes the session and every call applies without an error.

**Kept apart from the evaluation set.** No example repeats a trial of the study set (the same request on the same
session) that the model was evaluated on. The study set itself is not published here.

## Results of the model trained on it

Success means the resulting session exactly matches the target.

| | Untrained Gemma 4 E4B | Fine-tuned |
|---|---|---|
| Validation (100 examples) | — | 98% |
| Study set, standard (200) | 47.0% | 97.0% |
| Study set, hard (84, request kinds not in this data) | 19.0% | 65.5% |

## Limitations

The language is generated from templates. Real producers phrase things more freely, so a model trained only on this
data is weak on wording it has not seen.
