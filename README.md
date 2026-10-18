# Mixer Assistant: HAI FA26 Assignment 2

A producer or sound engineer tells an Ableton Live-style DAW what to change, in their own words, e.g.
*"bring the kick down a touch, put a reverb on the snare and loop bars 5 to 8"*. A fine-tuned **Gemma 4 E4B** turns
the request into tool calls (`set_volume`, `add_effect`, `set_loop`, ...) that the app applies. The person checks
the list of changes and can undo them in one step.

Everything here is our own: the task, the DAW interface, the dataset generator, the study set, the training data and
the fine-tuned model.

## Contents

> **The study set is not in this public repository.** `data/trials.*` and `results/` are left out until the user study
> (Assignment 3) is done, because the study set holds the correct answers that participants work towards. They are in
> the course submission. `node gen.js` recreates the study set exactly, and the app opens on a default session
> without it.

| Path | What it is |
|---|---|
| `index.html`, `style.css`, `app.js`, `daw.js`, `audio.js` | The study interface: a Live 12-style Arrangement View with a mixer, devices, clips, transport, an Info View and the assistant panel |
| `catalog.js` | Effects and their parameters, browser samples, named colors |
| `core.js` | Session model, the 24 **tools** (JSON schemas), applying tool calls, **scoring** and **error tagging** |
| `prompt.js` | What the model sees: the system prompt, the session as text, and parsing the model's reply |
| `dataset.js` | Generator for the study, training and validation trials, plus the hard study trials |
| `gen.js` | Writes `data/` (study set, training set, validation set) |
| `eval.js` | AI-only evaluation: runs a model through Ollama on every study trial and scores it |
| `test.js` | Tests: determinism, ground truth scores 100%, error tags, no study trial in the training data |
| `server.js` | Local web server for the app; it also proxies `/api/*` to Ollama |
| `data/trials.csv`, `data/trials.json` | **Study dataset**: 284 trials (200 standard + 84 hard) |
| `data/train.jsonl`, `data/val.jsonl` | **Training data**: 3,000 examples. **Validation data**: 300 examples. Chat format with tools. Also on Hugging Face: https://huggingface.co/datasets/ishaanjagyasi/gemma4-mixer-tool-calls |
| `training/` | Fine-tuning on U-M Great Lakes (`setup.sh`, `train.sbatch`, `train.py`), GGUF conversion (`convert.sbatch`), the Ollama `Modelfile`, a Colab version of the training notebook, the Hugging Face model card (`hf/`) and the job logs (`logs/`) |
| `results/ai/finetuned/`, `results/ai/base/` | Evaluation output for the fine-tuned and the untrained model: `results.csv` (study set + model output), `summary.md` (metrics + error distribution), `predictions.jsonl` (raw model replies) |

## Requirements

- **Node.js 20 or newer** (tested with 23.11). No npm packages are needed.
- **Ollama 0.40 or newer** (tested with 0.40.4), only to run a model.
- **Training only:** an NVIDIA GPU with 48 GB (we used one A40 on Great Lakes), Python 3.11 and Unsloth (`training/setup.sh` installs it).

## Reproduce the results

The following work without a GPU or a model:

```bash
node --test test.js                                   # 6 tests
node gen.js                                           # regenerates data/ deterministically (fixed seeds), prints dataset stats
node eval.js --model gemma4-mixer --label finetuned   # recomputes results/ai/finetuned/ from the saved predictions
node eval.js --model gemma4:e4b   --label base        # recomputes results/ai/base/
```

`eval.js` only calls the model for trials that are not yet in `predictions.jsonl`. All 284 are saved, so these
commands rescore the saved tool calls with `core.js` and rewrite `results.csv` and `summary.md`. To rerun a model
from scratch, delete its `predictions.jsonl`. This takes about 25–40 minutes on an M-series Mac.

### Running the models

The fine-tuned model is on Hugging Face: **https://huggingface.co/ishaanjagyasi/gemma4-e4b-mixer-assistant**. It holds:
- the 4-bit GGUF, 5.3 GB;
- the Ollama `Modelfile`;
- the LoRA adapter, 175 MB, which applies to `unsloth/gemma-4-E4B-it`.

```bash
ollama pull gemma4:e4b                       # untrained Gemma 4 E4B (4-bit), the baseline

# fine-tuned model (needs the Hugging Face CLI: pip install -U huggingface_hub)
hf download ishaanjagyasi/gemma4-e4b-mixer-assistant gemma4-mixer-Q4_K_M.gguf Modelfile --local-dir gemma4-mixer
cd gemma4-mixer && ollama create gemma4-mixer -f Modelfile
```

Ollama 0.40 no longer accepts LoRA adapters, so the GGUF is the way to load the fine-tuned model into Ollama.
`training/logs/` has the training log, the GGUF conversion log and the model's answers on 100 validation examples.

### Running the app

```bash
node server.js        # then open http://localhost:8000 (Ollama must be running)
```

Type a request in the Assistant panel on the right. The Model field chooses the model. Each request sends a fresh
snapshot of the session with it: every track's settings, effects and clips, plus the selected track and time
selection, so "this track" works. The panel lists every change, and **Undo** (or Cmd+Z) reverts the whole request.

## Study dataset (`data/trials.csv`)

Each row is one task trial: a session plus a request.

| Column | Meaning |
|---|---|
| `id` | `T001`–`T200` standard, `H001`–`H084` hard |
| `set`, `challenge` | `standard` or `hard`; for hard trials, which challenge (see below) |
| `register` | `casual` (spoken, vague words like "a touch") or `precise` (exact values like "-7.5 dB", "126.5 BPM") |
| `n_clauses`, `n_calls` | How many separate requests the instruction contains, and how many tool calls the answer needs |
| `tools`, `ref_types`, `value_types` | Which tools, how tracks are referred to (name, "track 3", "the drums", described), and kinds of values |
| `instruction` | **Input:** the request, in natural language |
| `initial_state` | **Input:** the session before the request (JSON) |
| `ground_truth_tool_calls` | **Ground truth:** the correct tool calls |
| `target_state` | **Ground truth:** the session after the correct tool calls; this is what is scored |

`results/ai/<model>/results.csv` holds the same trials plus `model_output_tool_calls`, `success`, precision, recall, F1,
the error tags and latency.

**Standard set (200).** Generated with seed 2026 on the 8-track study session (Kick, Snare, Hats, Bass, Keys, Pad,
Lead Vox, Back Vox).
- Requests contain 1, 3 or 6 clauses, 67/67/66 trials respectively.
- Wording is 105 casual and 95 precise.
- All 24 tools are covered.
- Tracks are referred to by name or alias, by number ("track 3"), or by group ("the drums").
- Vague words have fixed meanings, and the system prompt states them: "a touch" = 1 dB, "a bit" = 2 dB, "a few" = 3 dB, "a lot" = 6 dB, "a little left" = 15L, "more reverb" = +3 dB send.

**Hard set (84).** Generated with seed 4242. These are kinds of request the training generator never makes, 14 of each:

| Challenge | Example |
|---|---|
| described track | "Kill whichever drum track has the highest fader." / "Set the bottom track to -10 dB." |
| relative to another track | "Make the pad 5 dB quieter than the kick." / "Swap the pans of the bass and the lead vox." / "Speed the tempo up by 5%." |
| unseen slang | "Darken the bass by 3 dB." / "Dry up the snare completely." / "Sit the hats back 3 dB in the mix." |
| same-name tracks | Two tracks named Snare: "Put a reverb on the snare track that has clips." |
| refers to earlier clause | "Duplicate the lead vocal and mute the copy." / "Add a compressor to the bass and set its threshold to -20 dB." |
| long batch | 8–10 clauses in one request |

Every trial has exactly one correct result. The generator only keeps a trial if every clause changes the session, and
`test.js` checks that the ground truth scores 100% on every trial.

## Training data and model

**Data.** `data/train.jsonl` has 3,000 examples (seed 7001), and `data/val.jsonl` has 300 (seed 9001).
- They come from the same generator as the standard study set, with different seeds.
- Half use the study session and half use random 5–10-track sessions drawn from 18 track types.
- Each line holds the system prompt, the session and request, the correct tool calls as the assistant turn, and the tool schemas.

**Kept separate from the study set.**
- Any training or validation trial identical to a study trial (same request on the same session) is excluded. `test.js` checks this.
- No hard-set instruction appears in the training or validation data. `gen.js` checks this.
- The model was trained once, before the study set was evaluated. Nothing was tuned on the study set.

**Fine-tuning** (`training/train.py`, run with `sbatch train.sbatch --batch 4 --accum 1`):

| Setting | Value |
|---|---|
| Base model | `unsloth/gemma-4-E4B-it` (Gemma 4 E4B instruct) |
| Method | LoRA on the language model's attention and MLP layers. Rank 16, alpha 16, 16-bit base, about 37M trainable parameters |
| Loss | Only on the assistant's tool calls (`train_on_responses_only`). The rules and the session are not learned |
| Format | Gemma 4's own chat template with tools, thinking off, at most 4,096 tokens (examples average about 3,550) |
| Schedule | 1 epoch = 750 steps of batch 4. Learning rate 2e-4, linear decay, 20 warm-up steps, AdamW 8-bit |
| Hardware and time | 1 × NVIDIA A40 (48 GB) on U-M Great Lakes, 6.5 h, peak memory 23.7 GB |
| Final training loss | 0.0067 |
| Validation | 98 of 100 held-out validation examples exactly right |

**Export.**
1. Merge the LoRA adapter into the 16-bit model (`train.py`).
2. Convert to a 16-bit GGUF and quantize to Q4_K_M with llama.cpp (`training/convert.sbatch`).
3. Load into Ollama (`training/Modelfile`), which uses Ollama's built-in Gemma 4 renderer and parser so tool calls come back as structured `tool_calls`.

The untrained baseline is Ollama's `gemma4:e4b`, also 4-bit.

## Evaluation (`eval.js`, scoring in `core.js`)

Each model gets the same system prompt, session text and tools as in the app. It runs with temperature 0, thinking off
and an 8k context. Its tool calls are applied to `initial_state`, and the resulting session is compared with
`target_state`.

**Metrics.**
- **Success (exact match):** after the model's tool calls, the session equals the target session. This is the main metric, because a request is only done when everything asked for was done and nothing else changed.
- **Precision, recall and F1 over session settings:** the session is broken into individual settings ("Kick volume", "Snare send A", "loop start", "Bass › EQ Eight › Low" ...).
  - Recall = the share of settings that had to change and now have the right value.
  - Precision = the share of changed settings that are correct.
  - This gives partial credit on long requests.
- **Tolerances:**
  - volume and sends 0.25 dB
  - pan 1
  - tempo 0.25 BPM
  - frequency- and time-type effect parameters 1% (they use log scales)
  - other effect parameters 0.5% of their range

  These are tight enough to tell apart the precise values requests use, such as -7 vs -7.5 dB.
- Tracks are matched by identity, not position, so inserting or deleting a track doesn't shift the scoring.

**Error tags** (one per wrong setting; the error distribution table counts these):

| Tag | Meaning |
|---|---|
| omitted edit | A setting that should have changed was left as it was |
| wrong track | The requested change was made, but on a different track |
| wrong value | The right setting was changed to the wrong value |
| relative read as absolute | "Down 3 dB" was set to -3 dB |
| pan side flipped | Left and right were swapped |
| wrong track structure | A track was added, deleted or moved wrongly |
| extra unrequested change | Something changed that the request did not ask for |
| invalid tool call | A call the app could not apply (unknown track, effect or parameter, bad argument) |
| parse error | The reply could not be read as tool calls |

## Results (AI only, 284 study trials)

| Exactly right | Untrained Gemma 4 E4B | Fine-tuned (ours) |
|---|---|---|
| Standard set (200) | 47.0% | **97.0%** |
| Hard set (84) | 19.0% | **65.5%** |
| All (284) | 38.7% | **87.7%** |
| Mean F1, all | 0.636 | 0.918 |
| Mean latency per request (M-series Mac) | 5.0 s | 7.8 s |

The breakdown by register, clause count and challenge, and the error distribution tables, are in
`results/ai/finetuned/summary.md` and `results/ai/base/summary.md`.
