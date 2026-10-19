# Gemma 4 Mixer Assistant

Course project for HAI FA26 (Human-AI Interaction), Assignment 2.

The task: a producer describes a change to a music session in natural language, for example *"bring the kick down
a touch and put a reverb on the snare"*, and a model translates it into tool calls (`set_volume`, `add_effect`, ...)
for a DAW. The project includes:

- a browser DAW modelled on Ableton Live's Arrangement View, with an assistant panel that applies the model's
  tool calls, lists the changes and can undo them;
- a generator for the training data and the study set;
- Gemma 4 E4B fine-tuned with LoRA on 3,000 generated examples;
- an evaluation script that scores a model's tool calls against the target session.

## Results

Evaluated on 284 study trials that are not in the training data. A trial counts as correct only if the session after
the model's tool calls exactly matches the target.

| | Gemma 4 E4B (base) | Fine-tuned |
|---|---|---|
| Standard set (200) | 47.0% | 97.0% |
| Hard set (84) | 19.0% | 65.5% |

The hard set has request types the training data does not cover, such as values relative to another track
(*"5 dB quieter than the kick"*), tracks that share a name, and unseen slang. Most remaining errors are there.

## Files

```
app/          the DAW interface (index.html, style.css, app.js, daw.js, audio.js)
lib/          code shared by the app and the scripts
  core.js       session model, the 24 tool definitions, applying calls, scoring
  catalog.js    effects, samples and colours
  prompt.js     system prompt and session text sent to the model
  dataset.js    trial generator
scripts/      gen.js (writes data/), eval.js (evaluation through Ollama)
tests/        test.js
training/     fine-tuning on U-M Great Lakes, GGUF conversion, Ollama Modelfile, logs
data/         train.jsonl (3,000) and val.jsonl (300) training and validation examples
server.js     local server for the app; forwards model requests to Ollama
```

The study set (`data/trials.*`) and evaluation outputs (`results/`) are not in this repository, since the study set
will be used in the Assignment 3 user study.

## Running

Requires Node.js 20+ and Ollama 0.40+.

```bash
# fine-tuned model
hf download ishaanjagyasi/gemma4-e4b-mixer-assistant gemma4-mixer-Q4_K_M.gguf Modelfile --local-dir gemma4-mixer
cd gemma4-mixer && ollama create gemma4-mixer -f Modelfile && cd ..

# app at http://localhost:8000
node server.js

# data and evaluation
node scripts/gen.js
node scripts/eval.js --model gemma4-mixer --label finetuned
node --test tests/test.js
```

## Links

- Model: https://huggingface.co/ishaanjagyasi/gemma4-e4b-mixer-assistant
- Training data: https://huggingface.co/datasets/ishaanjagyasi/gemma4-mixer-tool-calls
