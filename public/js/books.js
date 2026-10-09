// KoolKat Books: read books made of pages (text, pictures, or both), listen
// to their audiobooks, and (with KoolKat Unlimited) write your own.
//
// app.js passes in its helpers (the DOM helpers, api, toasts, comments, ...)
// so this file only has to know about books.

export function createBooks(h) {
  const { $, el, api, toast, withBusy, avatar, badgeImg, openUserProfile, openComments, show, askConfirm, timeAgo, formatTime, API_BASE, getToken } = h;
  const media = (url) => (url ? `${API_BASE}/api/${url}` : null);
  const state = { list: [], canCreate: false, query: '', book: null, page: 0, more: false, loading: false };
  // Each book without a cover gets one in a colour of its own.
  const coverHue = (book) => (book.id * 47) % 360;

  /** A book's cover: its picture, or its title on a coloured cover. */
  function cover(book, cls = '') {
    const node = el('span', { class: `book-cover ${cls}` });
    if (book.cover) node.append(el('img', { src: media(book.cover), alt: '', loading: 'lazy' }));
    else {
      node.classList.add('plain');
      node.style.setProperty('--book-hue', String(coverHue(book)));
      node.append(el('span', { class: 'book-cover-title', text: book.title }));
    }
    if (book.audiobook) node.append(el('span', { class: 'book-cover-audio', title: 'Has an audiobook', text: '🎧' }));
    return node;
  }

  // ---------- the shelf ----------
  async function open() {
    show('books');
    await load();
  }
  async function load(more = false) {
    if (state.loading) return;
    state.loading = true;
    try {
      const before = more && state.list.length ? `&before=${state.list.at(-1).id}` : '';
      const query = state.query ? `&q=${encodeURIComponent(state.query)}` : '';
      const { books, canCreate, more: hasMore } = await api('GET', `/books?limit=40${before}${query}`);
      state.list = more ? [...state.list, ...books] : books;
      state.canCreate = canCreate;
      state.more = hasMore;
      renderShelf();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      state.loading = false;
    }
  }
  function renderShelf() {
    $('btn-book-new').classList.toggle('locked', !state.canCreate);
    $('books-empty').hidden = state.list.length > 0;
    $('books-empty').textContent = state.query ? `No books match “${state.query}”.` : state.canCreate ? 'No books yet. Tap ＋ to write the first one!' : 'No books yet.';
    $('books-grid').replaceChildren(
      ...state.list.map((b) =>
        el(
          'button',
          { type: 'button', class: 'book-card', onclick: () => openBook(b.id) },
          cover(b),
          el('span', { class: 'book-card-title', text: b.title }),
          el('span', { class: 'book-card-author' }, el('span', { text: b.author.displayName }), badgeImg(b.author)),
          el('span', { class: 'book-card-meta', text: `${b.pageCount} page${b.pageCount === 1 ? '' : 's'} · ♥ ${b.likes}${b.audiobook ? ' · 🎧' : ''}` })
        )
      )
    );
    $('btn-books-more').hidden = !state.more;
  }
  let searchTimer = 0;
  $('books-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value.trim();
      load();
    }, 250);
  });
  $('btn-books-more').addEventListener('click', () => load(true));
  $('btn-books-back').addEventListener('click', () => h.goHome());
  $('btn-book-new').addEventListener('click', () => {
    if (!state.canCreate) {
      toast('📚 Making books is part of KoolKat Unlimited. Anyone can read them!', { error: true });
      return;
    }
    openEditor(null);
  });

  // ---------- reading ----------
  async function openBook(id) {
    try {
      const { book } = await api('GET', `/books/${id}`);
      state.book = book;
      state.page = 0;
      show('book');
      renderBook();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }
  function renderBook() {
    const b = state.book;
    if (!b) return;
    $('book-title').textContent = b.title;
    $('book-info').replaceChildren(
      cover(b, 'small'),
      el(
        'div',
        { class: 'book-info-text' },
        el('strong', { text: b.title }),
        el('button', { type: 'button', class: 'author-link', onclick: () => openUserProfile(b.author.id) }, avatar(b.author, 'small'), el('span', { text: b.author.displayName }), badgeImg(b.author)),
        b.description ? el('p', { class: 'book-description', text: b.description }) : null,
        el('span', { class: 'fineprint', text: `${b.pageCount} page${b.pageCount === 1 ? '' : 's'} · ${timeAgo(b.createdAt)}` })
      )
    );
    // The audiobook, if there is one.
    const audio = $('book-audio');
    $('book-audio-box').hidden = !b.audiobook;
    if (b.audiobook) {
      const src = media(b.audiobook.url);
      if (audio.dataset.src !== src) {
        audio.dataset.src = src;
        audio.src = src;
      }
      $('book-audio-length').textContent = b.audiobook.duration ? formatTime(b.audiobook.duration) : '';
    } else {
      audio.pause();
      audio.removeAttribute('src');
      audio.dataset.src = '';
    }
    $('btn-book-like').textContent = `${b.liked ? '♥' : '♡'} ${b.likes}`;
    $('btn-book-like').classList.toggle('on', b.liked);
    $('btn-book-like').setAttribute('aria-pressed', String(b.liked));
    $('btn-book-comments').textContent = `💬 ${b.comments}`;
    $('book-owner-actions').hidden = !b.mine && !b.canDelete;
    $('btn-book-edit').hidden = !b.mine;
    $('btn-book-audiobook').hidden = !b.mine;
    $('btn-book-audiobook').textContent = b.audiobook ? '🎧 Change the audiobook' : '🎧 Add an audiobook';
    $('btn-book-audio-remove').hidden = !b.mine || !b.audiobook;
    renderPage();
  }
  function renderPage() {
    const b = state.book;
    const p = b.pages[state.page];
    const page = $('book-page');
    page.replaceChildren(
      ...[
        p.image ? el('img', { class: 'book-page-image', src: media(p.image), alt: `Picture on page ${state.page + 1}` }) : null,
        p.text ? el('div', { class: 'book-page-text', text: p.text }) : null,
      ].filter(Boolean)
    );
    page.classList.toggle('picture-only', Boolean(p.image && !p.text));
    page.scrollTop = 0;
    $('book-page-number').textContent = `Page ${state.page + 1} of ${b.pages.length}`;
    $('btn-book-prev').disabled = state.page === 0;
    $('btn-book-next').disabled = state.page >= b.pages.length - 1;
  }
  const turn = (d) => {
    const b = state.book;
    if (!b) return;
    const next = Math.max(0, Math.min(b.pages.length - 1, state.page + d));
    if (next === state.page) return;
    state.page = next;
    renderPage();
  };
  $('btn-book-prev').addEventListener('click', () => turn(-1));
  $('btn-book-next').addEventListener('click', () => turn(1));
  // Swipe to turn the page.
  let swipe = null;
  $('book-page').addEventListener('pointerdown', (e) => (swipe = { x: e.clientX, y: e.clientY }));
  $('book-page').addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
  });
  $('btn-book-back').addEventListener('click', () => {
    $('book-audio').pause();
    open();
  });
  $('btn-book-like').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      const b = state.book;
      const r = await api(b.liked ? 'DELETE' : 'POST', `/books/${b.id}/like`);
      Object.assign(b, { liked: r.liked, likes: r.likes });
      renderBook();
    })
  );
  $('btn-book-comments').addEventListener('click', () => {
    const b = state.book;
    openComments(b, () => renderBook(), 'books');
  });
  $('btn-book-edit').addEventListener('click', () => openEditor(state.book));
  $('btn-book-delete').addEventListener('click', async () => {
    const b = state.book;
    if (!(await askConfirm(`Delete “${b.title}”? This can't be undone.`, { ok: 'Delete' }))) return;
    try {
      await api('DELETE', `/books/${b.id}`);
      toast('Book deleted');
      $('book-audio').pause();
      open();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  // An audiobook on its own (add one to a book that's already out).
  $('btn-book-audiobook').addEventListener('click', () => $('book-audio-file-later').click());
  $('book-audio-file-later').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) return toast('Audiobooks can be up to 200 MB', { error: true });
    const button = $('btn-book-audiobook');
    await withBusy(button, async () => {
      const duration = await audioLength(file);
      const progress = $('book-audio-progress');
      progress.hidden = false;
      try {
        const { uploadId } = await upload('audio', file, (f) => progress.style.setProperty('--done', `${Math.round(f * 100)}%`));
        const { book } = await api('PUT', `/books/${state.book.id}/audiobook`, { audioId: uploadId, audioDuration: duration });
        state.book = { ...book, pages: book.pages };
        toast('🎧 Audiobook added');
        renderBook();
      } finally {
        progress.hidden = true;
      }
    });
  });
  $('btn-book-audio-remove').addEventListener('click', async () => {
    if (!(await askConfirm('Take the audiobook off this book?', { ok: 'Remove' }))) return;
    try {
      const { book } = await api('DELETE', `/books/${state.book.id}/audiobook`);
      state.book = book;
      renderBook();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  // ---------- writing (KoolKat Unlimited) ----------
  // A draft: pages are { text, image: { file, url } | { keep, url } | null }.
  const draft = { book: null, cover: null, pages: [], audio: null, removeAudio: false };

  function openEditor(book) {
    draft.book = book;
    draft.cover = book?.cover ? { keep: true, url: media(book.cover) } : null;
    draft.pages = book ? book.pages.map((p) => ({ text: p.text ?? '', image: p.image ? { keep: p.imageId, url: media(p.image) } : null })) : [{ text: '', image: null }];
    draft.audio = book?.audiobook ? { keep: true, name: 'Audiobook', duration: book.audiobook.duration } : null;
    draft.removeAudio = false;
    const form = $('book-form');
    form.reset();
    form.title.value = book?.title ?? '';
    form.description.value = book?.description ?? '';
    $('book-edit-heading').textContent = book ? 'Edit your book' : 'Write a book';
    $('btn-book-save').textContent = book ? 'Save' : 'Publish';
    renderEditor();
    $('dialog-book-edit').showModal();
  }
  function renderEditor() {
    const coverBtn = $('btn-book-cover');
    coverBtn.replaceChildren(draft.cover ? el('img', { src: draft.cover.url, alt: 'Cover' }) : el('span', {}, '＋', el('br'), 'Cover'));
    $('btn-book-cover-remove').hidden = !draft.cover;
    $('book-pages-edit').replaceChildren(
      ...draft.pages.map((p, i) => {
        const text = el('textarea', { rows: '4', maxlength: '5000', placeholder: 'Write this page… (or just add a picture)', 'aria-label': `Page ${i + 1} text` });
        text.value = p.text;
        text.addEventListener('input', () => (p.text = text.value));
        const pic = el(
          'button',
          { type: 'button', class: 'book-page-pic', 'aria-label': p.image ? `Change the picture on page ${i + 1}` : `Add a picture to page ${i + 1}`, onclick: () => pickImage((file) => setImage(p, file)) },
          p.image ? el('img', { src: p.image.url, alt: '' }) : el('span', { text: '🖼️ Add a picture' })
        );
        return el(
          'li',
          { class: 'book-page-edit' },
          el(
            'div',
            { class: 'book-page-edit-head' },
            el('strong', { text: `Page ${i + 1}` }),
            el('span', { class: 'spacer' }),
            el('button', { type: 'button', class: 'icon-mini', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1), text: '↑' }),
            el('button', { type: 'button', class: 'icon-mini', 'aria-label': 'Move down', disabled: i === draft.pages.length - 1, onclick: () => move(i, 1), text: '↓' }),
            el('button', { type: 'button', class: 'icon-mini', 'aria-label': `Remove page ${i + 1}`, disabled: draft.pages.length === 1, onclick: () => removePage(i), text: '✕' })
          ),
          text,
          el(
            'div',
            { class: 'book-page-edit-pic' },
            pic,
            p.image ? el('button', { type: 'button', class: 'link-btn', text: 'Remove picture', onclick: () => ((p.image = null), renderEditor()) }) : null
          )
        );
      })
    );
    $('btn-book-page-add').disabled = draft.pages.length >= 200;
    const a = draft.audio;
    $('book-audio-name').textContent = a ? `🎧 ${a.name}${a.duration ? ` · ${formatTime(a.duration)}` : ''}` : '';
    $('btn-book-audio').textContent = a ? '🎧 Change the audiobook' : '🎧 Add an audiobook (optional)';
    $('btn-book-audio-clear').hidden = !a;
  }
  const move = (i, d) => {
    const [p] = draft.pages.splice(i, 1);
    draft.pages.splice(i + d, 0, p);
    renderEditor();
  };
  const removePage = (i) => {
    draft.pages.splice(i, 1);
    renderEditor();
  };
  $('btn-book-page-add').addEventListener('click', () => {
    draft.pages.push({ text: '', image: null });
    renderEditor();
    $('book-pages-edit').lastElementChild?.querySelector('textarea')?.focus();
  });
  let onPicked = null;
  const pickImage = (fn) => {
    onPicked = fn;
    $('book-image-file').click();
  };
  $('book-image-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !onPicked) return;
    if (!file.type.startsWith('image/')) return toast('Choose a picture', { error: true });
    if (file.size > 10 * 1024 * 1024) return toast('Pictures can be up to 10 MB', { error: true });
    onPicked(file);
  });
  const setImage = (p, file) => {
    p.image = { file, url: URL.createObjectURL(file) };
    renderEditor();
  };
  $('btn-book-cover').addEventListener('click', () =>
    pickImage((file) => {
      draft.cover = { file, url: URL.createObjectURL(file) };
      renderEditor();
    })
  );
  $('btn-book-cover-remove').addEventListener('click', () => {
    draft.cover = null;
    renderEditor();
  });
  $('btn-book-audio').addEventListener('click', () => $('book-audio-file').click());
  $('book-audio-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) return toast('Audiobooks can be up to 200 MB', { error: true });
    draft.audio = { file, name: file.name, duration: await audioLength(file) };
    renderEditor();
  });
  $('btn-book-audio-clear').addEventListener('click', () => {
    if (draft.audio?.keep) draft.removeAudio = true;
    draft.audio = null;
    renderEditor();
  });
  $('btn-book-cancel').addEventListener('click', () => $('dialog-book-edit').close());

  $('book-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    await withBusy($('btn-book-save'), async () => {
      const title = form.title.value.trim();
      if (!title) throw new Error('Give your book a title');
      const empty = draft.pages.findIndex((p) => !p.text.trim() && !p.image);
      if (empty >= 0) throw new Error(`Page ${empty + 1} is empty: give it some text, a picture, or both`);
      const step = $('book-upload-step');
      const bar = $('book-upload-progress');
      bar.hidden = step.hidden = false;
      try {
        // Upload the new pictures and recording first, one at a time.
        const files = [];
        if (draft.cover?.file) files.push(['cover', draft.cover, 'the cover']);
        draft.pages.forEach((p, i) => p.image?.file && files.push(['image', p.image, `the picture on page ${i + 1}`]));
        if (draft.audio?.file) files.push(['audio', draft.audio, 'the audiobook']);
        for (const [n, [kind, item, label]] of files.entries()) {
          step.textContent = `Uploading ${label}… (${n + 1} of ${files.length})`;
          bar.style.setProperty('--done', '0%');
          item.uploadId ??= (await upload(kind, item.file, (f) => bar.style.setProperty('--done', `${Math.round(f * 100)}%`))).uploadId;
        }
        step.textContent = draft.book ? 'Saving…' : 'Publishing…';
        const body = {
          title,
          description: form.description.value.trim() || null,
          coverId: draft.cover?.uploadId ?? null,
          keepCover: Boolean(draft.cover?.keep),
          pages: draft.pages.map((p) => ({ text: p.text.trim() || null, image: p.image ? (p.image.keep ? { keep: p.image.keep } : { upload: p.image.uploadId }) : null })),
          ...(draft.book ? {} : { audioId: draft.audio?.uploadId ?? null, audioDuration: draft.audio?.duration ?? null }),
        };
        let book;
        if (draft.book) {
          ({ book } = await api('PUT', `/books/${draft.book.id}`, body));
          if (draft.audio?.uploadId) ({ book } = await api('PUT', `/books/${book.id}/audiobook`, { audioId: draft.audio.uploadId, audioDuration: draft.audio.duration }));
          else if (draft.removeAudio) ({ book } = await api('DELETE', `/books/${book.id}/audiobook`));
          toast('📚 Saved');
        } else {
          ({ book } = await api('POST', '/books', body));
          toast(`📚 “${book.title}” is out!`);
        }
        $('dialog-book-edit').close();
        state.book = book;
        state.page = 0;
        show('book');
        renderBook();
      } finally {
        bar.hidden = step.hidden = true;
      }
    });
  });

  // ---------- helpers ----------
  function upload(kind, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/books/upload?kind=${kind}`);
      xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
      xhr.setRequestHeader('content-type', blob.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // Not JSON: use the status below.
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Couldn't upload. Check your connection."));
      xhr.send(blob);
    });
  }
  /** How long a recording is (null if the browser can't tell). */
  function audioLength(file) {
    return new Promise((resolve) => {
      const probe = new Audio();
      probe.preload = 'metadata';
      const url = URL.createObjectURL(file);
      const done = (v) => {
        URL.revokeObjectURL(url);
        resolve(v);
      };
      probe.addEventListener('loadedmetadata', () => done(Number.isFinite(probe.duration) ? probe.duration : null));
      probe.addEventListener('error', () => done(null));
      setTimeout(() => done(null), 8000);
      probe.src = url;
    });
  }

  return {
    open,
    openBook,
    /** Arrow keys turn the page while reading. */
    keyDown(e) {
      if (e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
      if (e.key === 'ArrowRight') turn(1);
      else if (e.key === 'ArrowLeft') turn(-1);
    },
    stop: () => $('book-audio').pause(),
  };
}
