# Fine-tunes Gemma 4 E4B with LoRA on the mixer tool-calling data (data/train.jsonl), checks it on validation
# examples it has never seen, and saves the LoRA adapter, the merged 16-bit model and (if it can) a Q8_0 GGUF.
# Runs on a GPU node via train.sbatch. Based on Unsloth's Gemma 4 notebook.
import argparse, json, os, re, time

p = argparse.ArgumentParser()
p.add_argument('--model', default='unsloth/gemma-4-E4B-it')
p.add_argument('--data', default='data')
p.add_argument('--out', default='out')
p.add_argument('--max-seq', type=int, default=4096)
p.add_argument('--epochs', type=float, default=1)
p.add_argument('--max-steps', type=int, default=-1, help='stop early (for a quick test run)')
p.add_argument('--batch', type=int, default=2)
p.add_argument('--accum', type=int, default=2)
p.add_argument('--rank', type=int, default=16)
p.add_argument('--lr', type=float, default=2e-4)
p.add_argument('--val-n', type=int, default=100)
p.add_argument('--no-merged', action='store_true')
p.add_argument('--no-gguf', action='store_true')
args = p.parse_args()
os.makedirs(args.out, exist_ok=True)
log = lambda *a: print(time.strftime('[%H:%M:%S]'), *a, flush=True)

from unsloth import FastModel
from unsloth.chat_templates import train_on_responses_only
import torch
from datasets import Dataset
from trl import SFTTrainer, SFTConfig

log('loading', args.model)
model, tokenizer = FastModel.from_pretrained(model_name=args.model, dtype=None, max_seq_length=args.max_seq, load_in_4bit=False, full_finetuning=False)
model = FastModel.get_peft_model(
    model, finetune_vision_layers=False, finetune_language_layers=True, finetune_attention_modules=True, finetune_mlp_modules=True,
    r=args.rank, lora_alpha=args.rank, lora_dropout=0, bias='none', random_state=3407,
)
text_tok = getattr(tokenizer, 'tokenizer', tokenizer)  # the plain text tokenizer (tokenizer may be a multimodal processor)

# Gemma's own chat template writes the tools and tool calls; thinking is off, as in the app (think: false).
def render(ex, prompt_only=False):
    msgs = ex['messages'][:2] if prompt_only else ex['messages']
    return text_tok.apply_chat_template(msgs, tools=ex['tools'], tokenize=False, add_generation_prompt=prompt_only, enable_thinking=False)

load = lambda path: [json.loads(line) for line in open(path)]
train_rows, val_rows = load(f'{args.data}/train.jsonl'), load(f'{args.data}/val.jsonl')
texts = [render(ex).removeprefix('<bos>') for ex in train_rows]
lengths = [len(text_tok(t)['input_ids']) for t in texts]
keep = [t for t, n in zip(texts, lengths) if n <= args.max_seq]
log(f'{len(texts)} training examples; tokens min {min(lengths)}, mean {sum(lengths) // len(lengths)}, max {max(lengths)}; kept {len(keep)} (<= {args.max_seq})')

trainer = SFTTrainer(
    model=model, tokenizer=tokenizer, train_dataset=Dataset.from_dict({'text': keep}), eval_dataset=None,
    args=SFTConfig(
        dataset_text_field='text', per_device_train_batch_size=args.batch, gradient_accumulation_steps=args.accum,
        warmup_steps=20, num_train_epochs=args.epochs, max_steps=args.max_steps, learning_rate=args.lr, logging_steps=10,
        optim='adamw_8bit', weight_decay=0.001, lr_scheduler_type='linear', seed=3407, report_to='none',
        output_dir=f'{args.out}/checkpoints', save_strategy='steps', save_steps=200, save_total_limit=2,
    ),
)
# learn only the model's answer (the tool calls), not the rules or the session
trainer = train_on_responses_only(trainer, instruction_part='<|turn>user\n', response_part='<|turn>model\n')
labels = trainer.train_dataset[0]['labels']
log('learned part of example 0:', text_tok.decode([x for x in labels if x != -100]))

stats = trainer.train()
log(f"trained in {stats.metrics['train_runtime'] / 60:.1f} min; peak GPU memory {torch.cuda.max_memory_reserved() / 1024**3:.1f} GB")
model.save_pretrained(f'{args.out}/lora'); tokenizer.save_pretrained(f'{args.out}/lora')
log('saved adapter to', f'{args.out}/lora')

# ---- check on validation examples: parse Gemma's tool-call text and compare with the correct calls ----
CALL = re.compile(r'<\|tool_call>call:(\w+)\{(.*?)\}<tool_call\|>', re.S)
def parse_calls(text):
    calls = []
    for name, body in CALL.findall(text):
        body = re.sub(r'([{,])\s*([A-Za-z_]\w*)\s*:', r'\1"\2":', '{' + body.replace('<|"|>', '"') + '}')
        try: calls.append((name, json.loads(body)))
        except json.JSONDecodeError: calls.append((name, {'_unparsed': body}))
    return calls
norm = lambda calls: [(n, {k: (round(float(v), 2) if isinstance(v, (int, float)) and not isinstance(v, bool) else v) for k, v in sorted(a.items())}) for n, a in calls]

exact = same_set = 0
with open(f'{args.out}/val_predictions.jsonl', 'w') as f:
    for i, ex in enumerate(val_rows[:args.val_n]):
        inputs = text_tok(render(ex, prompt_only=True).removeprefix('<bos>'), return_tensors='pt').to('cuda')
        out = model.generate(**inputs, max_new_tokens=600, do_sample=False)
        raw = text_tok.decode(out[0][inputs['input_ids'].shape[1]:], skip_special_tokens=False)
        got, want = norm(parse_calls(raw)), norm([(c['function']['name'], c['function']['arguments']) for c in ex['messages'][2]['tool_calls']])
        exact += got == want
        same_set += sorted(map(json.dumps, got)) == sorted(map(json.dumps, want))
        f.write(json.dumps({'request': ex['messages'][1]['content'].split('Request: ')[-1], 'raw': raw, 'got': got, 'want': want}) + '\n')
        if i < 5: log(f'REQUEST: {ex["messages"][1]["content"].split("Request: ")[-1]}\n  MODEL:    {got}\n  EXPECTED: {want}')
n = min(args.val_n, len(val_rows))
log(f'validation: {exact}/{n} exactly right ({100 * exact / n:.0f}%), {same_set}/{n} right calls in any order ({100 * same_set / n:.0f}%)')

if not args.no_merged:
    model.save_pretrained_merged(f'{args.out}/merged', tokenizer)
    log('saved merged 16-bit model to', f'{args.out}/merged')
if not args.no_gguf:
    try:
        model.save_pretrained_gguf(f'{args.out}/gguf', tokenizer, quantization_method='Q8_0')
        log('saved GGUF to', f'{args.out}/gguf')
    except Exception as e:  # the adapter and merged model are already saved
        log('GGUF export failed:', repr(e))
log('done')
