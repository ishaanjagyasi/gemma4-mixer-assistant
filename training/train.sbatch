#!/bin/bash
# Great Lakes job: fine-tune Gemma 4 E4B on one A40 GPU (course account limits: 1 GPU, 8 hours).
# Submit from ~/a2-gemma:  sbatch train.sbatch [extra train.py options, e.g. --max-steps 20 --val-n 5 --no-merged --no-gguf]
#SBATCH --job-name=gemma4-mixer
#SBATCH --account=pat463563f26_class
#SBATCH --partition=spgpu
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48G
#SBATCH --time=08:00:00
#SBATCH --output=logs/%x-%j.out

module load python/3.11.5 gcc/13.2.0 cmake/3.26.3
source "$HOME/a2-gemma/venv/bin/activate"
export HF_HOME="$HOME/a2-gemma/hf" HF_HUB_ENABLE_HF_TRANSFER=1 PYTHONUNBUFFERED=1
cd "$HOME/a2-gemma"
echo "node $SLURMD_NODENAME, job $SLURM_JOB_ID"; nvidia-smi --query-gpu=name,memory.total --format=csv
python train.py "$@"
