#!/bin/bash
# Great Lakes CPU job: turns the merged fine-tuned model (out/merged) into a 4-bit GGUF file that Ollama can load.
# (train.py's own GGUF export failed on a pip error; Ollama no longer accepts LoRA adapters, so this is the route.)
# Submit from ~/a2-gemma:  sbatch convert.sbatch
#SBATCH --job-name=gemma4-gguf
#SBATCH --account=pat463563f26_class
#SBATCH --partition=standard
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.out
set -e
module load python/3.11.5 gcc/13.2.0 cmake/3.26.3
source "$HOME/a2-gemma/venv/bin/activate"
LC="$HOME/.unsloth/llama.cpp" OUT="/scratch/pat463563f26_class_root/pat463563f26_class/$USER"
cd "$HOME/a2-gemma"
date +%H:%M; echo "1/3 converting to a 16-bit GGUF"
python "$LC/convert_hf_to_gguf.py" out/merged --outtype bf16 --outfile "$OUT/gemma4-mixer-bf16.gguf"
date +%H:%M; echo "2/3 building llama-quantize"
cmake -S "$LC" -B "$LC/build" -DGGML_CUDA=OFF -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release > /dev/null
cmake --build "$LC/build" --target llama-quantize -j 8 > /dev/null
date +%H:%M; echo "3/3 quantizing to Q4_K_M"
"$LC/build/bin/llama-quantize" "$OUT/gemma4-mixer-bf16.gguf" "$OUT/gemma4-mixer-Q4_K_M.gguf" Q4_K_M
ls -la "$OUT"; date +%H:%M; echo CONVERT_DONE
