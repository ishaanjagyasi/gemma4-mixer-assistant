# Mixer Assistant

Talk to a music app in plain words, and an AI makes the changes.

You type something like *"bring the kick down a touch and put a reverb on the snare"*. A small AI model
(Gemma 4 E4B, which we fine-tuned) turns it into actions, such as lowering the kick's volume by 1 dB and adding a
reverb to the snare. The app makes the changes, shows you a list of them, and lets you undo them with one click.

Made for HAI FA26, Assignment 2.

## Try it

You need [Node.js](https://nodejs.org) and [Ollama](https://ollama.com).

1. Get the fine-tuned model from Hugging Face:
   ```bash
   hf download ishaanjagyasi/gemma4-e4b-mixer-assistant gemma4-mixer-Q4_K_M.gguf Modelfile --local-dir gemma4-mixer
   cd gemma4-mixer && ollama create gemma4-mixer -f Modelfile && cd ..
   ```
2. Start the app:
   ```bash
   node server.js
   ```
3. Open http://localhost:8000 and type a request in the Assistant panel on the right.

## How well it works

We tested it on 284 requests it had never seen. A request counts as right only if every change is exactly correct.

| | Gemma 4 before training | After our training |
|---|---|---|
| Normal requests (200) | 47% | **97%** |
| Hard requests (84) | 19% | **66%** |

The hard requests are kinds the model was never trained on, for example *"make the pad 5 dB quieter than the
kick"* or two tracks with the same name. That is where it still makes mistakes, so check its changes.

## What's in here

| File | What it does |
|---|---|
| `index.html`, `app.js`, `daw.js`, `audio.js`, `style.css` | The app, which looks like Ableton Live |
| `core.js` | The 24 actions the AI can take, and the scoring |
| `prompt.js` | What the AI is told with each request |
| `dataset.js`, `gen.js` | Make the training and test requests |
| `eval.js` | Tests a model on every request and scores it |
| `test.js` | Checks that the code works (`node --test test.js`) |
| `training/` | How we trained the model on a GPU, plus the training logs |
| `data/train.jsonl`, `data/val.jsonl` | The 3,000 training and 300 practice examples |

**The test set is not here.** It holds the right answers for the user study in Assignment 3, so it stays private
until then.

## Links

- Model: https://huggingface.co/ishaanjagyasi/gemma4-e4b-mixer-assistant
- Training data: https://huggingface.co/datasets/ishaanjagyasi/gemma4-mixer-tool-calls
