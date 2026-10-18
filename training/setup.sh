#!/bin/bash
# One-time setup on the Great Lakes login node: a Python environment with Unsloth, and the base model download.
# Package versions follow Unsloth's Gemma 4 notebook.
set -e
module load python/3.11.5
cd "$HOME/a2-gemma"
[ -d venv ] || python -m venv venv
source venv/bin/activate
pip install -q --upgrade pip
pip install -q unsloth
pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"
pip install -q "huggingface_hub>=1.5.0,<2.0" hf_transfer
python -c "import torch, transformers, unsloth, trl; print('torch', torch.__version__, 'transformers', transformers.__version__, 'trl', trl.__version__)"
export HF_HOME="$HOME/a2-gemma/hf" HF_HUB_ENABLE_HF_TRANSFER=1
python -c "from huggingface_hub import snapshot_download; print(snapshot_download('unsloth/gemma-4-E4B-it'))"
du -sh "$HOME/a2-gemma/venv" "$HOME/a2-gemma/hf"
echo SETUP_DONE
