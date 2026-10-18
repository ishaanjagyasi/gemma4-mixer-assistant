---
base_model: unsloth/gemma-4-E4B-it
datasets:
- ishaanjagyasi/gemma4-mixer-tool-calls
license: apache-2.0
tags:
- gemma4
- tool-calling
- function-calling
- lora
- gguf
- music-production
- daw
---

# Gemma 4 E4B Mixer Assistant

This is Gemma 4 E4B (instruct), fine-tuned with LoRA. It turns a producer's or sound engineer's request into tool calls
for an Ableton Live-style DAW. For example:

> *"Bring the kick down a touch, put a reverb on the snare and loop bars 5 to 8."*
> → `set_volume(Kick, -1, relative)`, `add_effect(Snare, Reverb)`, `set_loop(start_bar 5, length 4)`

It was made for the University of Michigan course *Human-AI Interaction* (Fall 2026, Assignment 2). The app, the
dataset generator, the evaluation and the training code are in the course submission.

## Files

| File | What it is |
|---|---|
| `gemma4-mixer-Q4_K_M.gguf` | Merged model, 4-bit Q4_K_M (5.3 GB), for Ollama or llama.cpp |
| `Modelfile` | Ollama Modelfile: Gemma 4 renderer and parser, so tool calls come back as structured `tool_calls` |
| `lora/` | The LoRA adapter (175 MB) for `unsloth/gemma-4-E4B-it`, for use with PEFT or Unsloth |

## Use with Ollama

```bash
hf download ishaanjagyasi/gemma4-e4b-mixer-assistant gemma4-mixer-Q4_K_M.gguf Modelfile --local-dir .
ollama create gemma4-mixer -f Modelfile
```

Then call `/api/chat` with the app's system prompt, the session as text, the 24 tool schemas, `think: false` and a
context of at least 8k tokens. The prompt alone is about 3.5k tokens.

## Training

- **Data:** [ishaanjagyasi/gemma4-mixer-tool-calls](https://huggingface.co/datasets/ishaanjagyasi/gemma4-mixer-tool-calls), 3,000 synthetic examples. Each is a session described as text plus a request, with the correct tool calls as the answer. They mix casual, spoken requests ("a touch", "the drums") with precise ones ("-7.5 dB", "126.5 BPM"), with 1–6 requests each.
- **Method:** LoRA rank 16, alpha 16, on the language model's attention and MLP layers. The loss covers only the assistant's tool calls. Gemma 4's chat template, thinking off.
- **Schedule:** 1 epoch, 750 steps of batch 4, learning rate 2e-4.
- **Hardware:** 1 × A40 for 6.5 h. Final training loss 0.0067.

## Evaluation

Success means the session after the model's tool calls exactly matches the target session.

| | Untrained Gemma 4 E4B | This model |
|---|---|---|
| Held-out validation (100) | — | 98% |
| Study set, standard (200) | 47.0% | 97.0% |
| Study set, hard (84): described tracks, comparisons, unseen slang, same-name tracks, multi-step, long batches | 19.0% | 65.5% |

**Limitations.** The model was trained on generated requests only. It is weak at:
- values defined relative to another track ("3 dB quieter than the kick");
- telling apart tracks that share a name;
- wording it has not seen.

Check its changes before keeping them.
