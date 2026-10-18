import { createDaw } from './daw.js';
import { TOOLS } from './core.js';
import { messages, readReply } from './prompt.js';

const $ = s => document.querySelector(s);
const daw = createDaw({ onEvent: (type, data) => console.debug(type, data) });
// the study set (data/trials.json, made by gen.js); without it the app opens on the default session
const trials = await fetch('data/trials.json').then(r => (r.ok ? r.json() : [])).catch(() => []);
if (trials[1]) daw.setState(trials[1].initial);
window.daw = daw;

// ---------- assistant: a request goes to the model with a fresh snapshot of the session, the tool calls it returns
// are applied as one undoable step, and the resulting changes are listed for the person to check ----------
const pill = (text, cls = '') => { $('#aiState').textContent = text; $('#aiState').className = `pill ${cls}`; };
const say = text => { $('#answer').hidden = !text; $('#answer').textContent = text ?? ''; };
const li = (text, cls = '') => Object.assign(document.createElement('li'), { textContent: text, className: cls });

async function ask(text) {
  const input = $('#typed');
  input.disabled = true; pill('Thinking…', 'thinking'); say('');
  $('#transcript').textContent = text; $('#plan').replaceChildren(); $('#undoBtn').disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: $('#model').value.trim(), messages: messages(daw.session(), text), tools: TOOLS, stream: false, think: false, keep_alive: '30m', options: { temperature: 0, num_ctx: 8192 } }),
    });
    const r = await res.json();
    if (!res.ok || r.error) throw new Error(r.error ?? `HTTP ${res.status}`);
    const { calls, content, parseError } = readReply(r.message);
    const { errors, changes } = daw.applyCalls(calls);
    $('#plan').append(...changes.map(c => li(c)), ...errors.map(e => li(`Could not do: ${e}`, 'err')));
    if (!changes.length && !errors.length) $('#plan').append(li('Nothing changed.', 'err'));
    if (parseError) say(`The model's answer could not be read: ${content}`);
    else if (!calls.length && content.trim()) say(content.trim());
    $('#undoBtn').disabled = !changes.length;
    pill('Ready');
  } catch (e) {
    pill('Error', 'error'); say(`Could not reach the model: ${e.message}`);
  } finally {
    input.disabled = false; input.focus();
  }
}

$('#typed').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  ask(e.target.value.trim()); e.target.value = '';
});
$('#undoBtn').onclick = () => { daw.undo(); $('#undoBtn').disabled = true; $('#plan').append(li('Undone.', 'err')); };
