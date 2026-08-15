interface Entry {
  id: number;
  text: string;
  created_at: number;
  pinned: number;
}

interface ClipboardAPI {
  search(query: string): Promise<Entry[]>;
  selectEntry(id: number): Promise<void>;
  hidePopup(): void;
  onResetSearch(callback: () => void): void;
}

const api = (window as unknown as { clipboardAPI: ClipboardAPI }).clipboardAPI;

const searchInput = document.getElementById('search') as HTMLInputElement;
const listEl = document.getElementById('list') as HTMLUListElement;

let results: Entry[] = [];
let selectedIndex = 0;

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? collapsed.slice(0, 200) + '…' : collapsed;
}

function render(): void {
  listEl.innerHTML = '';
  if (results.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No matching entries';
    listEl.appendChild(li);
    return;
  }
  results.forEach((entry, i) => {
    const li = document.createElement('li');
    li.textContent = summarize(entry.text);
    if (i === selectedIndex) li.classList.add('selected');
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      choose(i);
    });
    listEl.appendChild(li);
  });
}

function highlight(index: number): void {
  selectedIndex = index;
  render();
  const el = listEl.children[selectedIndex] as HTMLElement | undefined;
  el?.scrollIntoView({ block: 'nearest' });
}

async function refresh(): Promise<void> {
  results = await api.search(searchInput.value);
  selectedIndex = 0;
  render();
}

function choose(index: number): void {
  const entry = results[index];
  if (!entry) return;
  api.selectEntry(entry.id);
}

searchInput.addEventListener('input', () => {
  refresh();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (results.length > 0) highlight(Math.min(selectedIndex + 1, results.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (results.length > 0) highlight(Math.max(selectedIndex - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(selectedIndex);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    api.hidePopup();
  }
});

api.onResetSearch(() => {
  searchInput.value = '';
  searchInput.focus();
  refresh();
});

refresh();
