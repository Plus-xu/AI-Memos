const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { flush } = require('./helpers/scripts.cjs');
const { info, loadPopup } = require('./helpers/environments.cjs');

const key = 'memosIndex:' + JSON.stringify([info.apiUrl, info.userName]);
const refused = status => ({ status, responseJSON: { message: 'refused' } });
const never = () => {
  throw new Error('Unexpected request');
};

/** A request that stays open until the test settles it. */
function deferred() {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

/** What the tag button's list shows: whether it is open, and the tags or status text in it. */
function tagList(popup) {
  const html = popup.node('#taglist').html();
  const tags = Array.from(html.matchAll(/<button[^>]*>#([^<]*)<\/button>/g), match => match[1]);
  return { open: popup.document.getElementById('taglist').hidden === false, tags, text: tags.length ? '' : html };
}

async function clickTags(popup) {
  popup.handlers.get('#tags:click')();
  await flush();
}

async function clickRandom(popup) {
  popup.handlers.get('#random:click')();
  await flush();
}

/** Makes the page's random choice the first candidate. */
const alwaysPickFirst = popup => vm.runInContext('Math.random = () => 0', popup.context);

const shown = popup =>
  (
    popup
      .node('#randomlist')
      .html()
      .match(/data-uid="[^"]+"/g) || []
  ).map(value => value.slice(10, -1));

/** An index as session storage holds it, loaded just now unless a time says otherwise. */
const stored = fields => ({
  tags: null,
  tagsAt: Date.now(),
  scanned: false,
  names: null,
  namesAt: Date.now(),
  ...fields
});

test('tags come from the user statistics when the server has them, sorted, without listing memos', async () => {
  const popup = await loadPopup({ userTags: async () => ['work', 'a/b', 'a'], listMemos: never });
  await clickTags(popup);
  assert.deepEqual(tagList(popup), { open: true, tags: ['a', 'a/b', 'work'], text: '' });
  assert.deepEqual(popup.session[key].tags, ['a', 'a/b', 'work']);
});

test('without user statistics, opening, closing and reopening the tags lists the memos once', async () => {
  let lists = 0,
    statistics = 0;
  const popup = await loadPopup({
    userTags: async () => {
      statistics++;
      return null;
    },
    listMemos: async () => {
      lists++;
      return [
        { name: 'memos/a', tags: ['reading', 'work'] },
        { name: 'memos/b', tags: ['reading'] },
        { name: 'memos/c' }
      ];
    }
  });
  await clickTags(popup);
  assert.deepEqual(tagList(popup), { open: true, tags: ['reading', 'work'], text: '' });
  await clickTags(popup);
  assert.equal(tagList(popup).open, false);
  await clickTags(popup);
  assert.deepEqual(tagList(popup), { open: true, tags: ['reading', 'work'], text: '' });
  assert.equal(lists, 1);
  assert.equal(statistics, 1);
  assert.deepEqual(popup.session[key].names, ['memos/a', 'memos/b', 'memos/c'], 'the same pass feeds random review');
});

test('the tag list shows that it is working, and a second click while it loads closes it for good', async () => {
  const answer = deferred();
  const popup = await loadPopup({ userTags: () => answer.promise });
  await clickTags(popup);
  assert.deepEqual(tagList(popup), { open: true, tags: [], text: 'working' });
  await clickTags(popup);
  assert.equal(tagList(popup).open, false);
  answer.resolve(['a']);
  await flush();
  assert.equal(tagList(popup).open, false);
  assert.deepEqual(popup.session[key].tags, ['a'], 'the answer is still kept for the next click');
  assert.deepEqual(popup.messages, []);
});

test('tags older than ten minutes show at once and are replaced when the refresh arrives', async () => {
  const answer = deferred();
  const session = { [key]: stored({ tags: ['old'], tagsAt: Date.now() - 601e3 }) };
  const popup = await loadPopup({ userTags: () => answer.promise }, {}, session);
  await clickTags(popup);
  assert.deepEqual(tagList(popup), { open: true, tags: ['old'], text: '' });
  answer.resolve(['old', 'new']);
  await flush();
  assert.deepEqual(tagList(popup).tags, ['new', 'old']);
  assert.deepEqual(session[key].tags, ['new', 'old']);
  assert.ok(Date.now() - session[key].tagsAt < 5000);
});

test('tags younger than ten minutes are shown without asking the server', async () => {
  const session = { [key]: stored({ tags: ['kept'], tagsAt: Date.now() - 599e3 }) };
  const popup = await loadPopup({ userTags: never, listMemos: never }, {}, session);
  await clickTags(popup);
  assert.deepEqual(tagList(popup), { open: true, tags: ['kept'], text: '' });
});

test('a failed background refresh keeps the old tags on screen and says nothing', async () => {
  const session = { [key]: stored({ tags: ['old'], tagsAt: 1 }) };
  const popup = await loadPopup({ userTags: async () => Promise.reject(refused(500)) }, {}, session);
  await clickTags(popup);
  assert.deepEqual(tagList(popup), { open: true, tags: ['old'], text: '' });
  assert.deepEqual(popup.messages, []);
});

test('a first load that fails, finds no tags, or has no connection closes the list and says why', async () => {
  const failing = await loadPopup({ userTags: async () => Promise.reject(refused(403)) });
  await clickTags(failing);
  assert.equal(tagList(failing).open, false);
  assert.deepEqual(failing.messages, ['permissionDenied']);
  const empty = await loadPopup({ userTags: async () => [] });
  await clickTags(empty);
  assert.equal(tagList(empty).open, false);
  assert.deepEqual(empty.messages, ['noTagsFound']);
  const offline = await loadPopup({ userTags: never }, { apiTokens: '' });
  await clickTags(offline);
  assert.equal(tagList(offline).open, false);
  assert.deepEqual(offline.messages, ['connectMemos']);
});

test('saving a memo with a new tag adds it to the open list and to what a reopened popup shows', async () => {
  const session = {};
  const popup = await loadPopup(
    {
      userTags: async () => ['a'],
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['fresh', 'a'] })
    },
    {},
    session
  );
  await clickTags(popup);
  await popup.context.sendText();
  await flush();
  assert.deepEqual(tagList(popup), { open: true, tags: ['a', 'fresh'], text: '' });
  const reopened = await loadPopup({ userTags: never, listMemos: never }, {}, session);
  await clickTags(reopened);
  assert.deepEqual(tagList(reopened).tags, ['a', 'fresh']);
});

test('a saved memo is added to the names for random review; a reply without tags marks the tags stale', async () => {
  const session = { [key]: stored({ tags: ['a'], names: ['memos/old'] }) };
  const popup = await loadPopup({ createMemo: async (_, body) => ({ name: 'memos/saved', ...body }) }, {}, session);
  await popup.context.sendText();
  await flush();
  assert.deepEqual(session[key].names, ['memos/saved', 'memos/old']);
  assert.deepEqual(session[key].tags, ['a']);
  assert.equal(session[key].tagsAt, 0);
});

test('two random reviews list the memos once and fetch each shown memo by name', async () => {
  let lists = 0;
  const fetched = [];
  const popup = await loadPopup({
    listMemos: async () => {
      lists++;
      return [{ name: 'memos/a', content: 'listed' }];
    },
    getMemo: async (_, name) => {
      fetched.push(name);
      return { name, content: 'fetched' };
    }
  });
  await clickRandom(popup);
  assert.deepEqual(shown(popup), ['a']);
  assert.match(popup.node('#randomlist').html(), /fetched/);
  assert.equal(popup.node('#searchStatus').text(), '');
  await clickRandom(popup);
  assert.equal(lists, 1);
  assert.deepEqual(fetched, ['memos/a', 'memos/a']);
});

test('random review says it is working until the memo arrives', async () => {
  const answer = deferred();
  const popup = await loadPopup({ listMemos: () => answer.promise, getMemo: async (_, name) => ({ name }) });
  await clickRandom(popup);
  assert.equal(popup.node('#searchStatus').text(), 'working');
  answer.resolve([{ name: 'memos/a' }]);
  await flush();
  assert.equal(popup.node('#searchStatus').text(), '');
});

test('random review skips remembered memos that are archived or gone, and forgets them', async () => {
  const session = { [key]: stored({ names: ['memos/gone', 'memos/archived', 'memos/kept'] }) };
  const popup = await loadPopup(
    {
      listMemos: never,
      getMemo: async (_, name) => {
        if (name === 'memos/gone') throw refused(404);
        return { name, content: name, state: name === 'memos/archived' ? 'ARCHIVED' : 'NORMAL' };
      }
    },
    {},
    session
  );
  alwaysPickFirst(popup);
  await clickRandom(popup);
  assert.deepEqual(shown(popup), ['kept']);
  assert.deepEqual(session[key].names, ['memos/kept']);
});

test('random review lists the memos again when three remembered ones in a row are gone', async () => {
  let lists = 0;
  const session = {
    [key]: stored({ names: ['memos/1', 'memos/2', 'memos/3', 'memos/4'], namesAt: Date.now() - 60e3 })
  };
  const popup = await loadPopup(
    {
      listMemos: async () => {
        lists++;
        return [{ name: 'memos/new' }];
      },
      getMemo: async (_, name) => {
        if (name !== 'memos/new') throw refused(404);
        return { name, content: 'new' };
      }
    },
    {},
    session
  );
  alwaysPickFirst(popup);
  await clickRandom(popup);
  assert.deepEqual(shown(popup), ['new']);
  assert.equal(lists, 1);
  assert.deepEqual(session[key].names, ['memos/new']);
});

test('random review reports no memos after a fresh listing finds none, and an error as an error', async () => {
  let lists = 0;
  const empty = await loadPopup({
    listMemos: async () => {
      lists++;
      return [];
    }
  });
  await clickRandom(empty);
  assert.equal(empty.node('#searchStatus').text(), 'noMemosFound');
  assert.equal(lists, 1, 'a listing made a moment ago is not repeated');
  const failing = await loadPopup(
    { listMemos: never, getMemo: async () => Promise.reject(refused(500)) },
    {},
    { [key]: stored({ names: ['memos/a'] }) }
  );
  await clickRandom(failing);
  assert.equal(failing.node('#searchStatus').text(), '');
  assert.deepEqual(shown(failing), []);
  assert.equal(failing.messages.length, 1);
});

test('archiving removes the memo from the names and marks the tags stale; undo puts the name back', async () => {
  const session = { [key]: stored({ tags: ['a'], names: ['memos/a', 'memos/b'] }) };
  const popup = await loadPopup({ archiveMemo: async () => ({}), restoreMemo: async () => ({}) }, {}, session);
  await popup.context.archiveMemoByName('memos/a');
  await flush();
  assert.deepEqual(session[key].names, ['memos/b']);
  assert.equal(session[key].tagsAt, 0);
  await popup.context.undoArchive();
  await flush();
  assert.deepEqual(session[key].names.toSorted(), ['memos/a', 'memos/b']);
});

test("another account's remembered tags and names are never used", async () => {
  const other = 'memosIndex:' + JSON.stringify([info.apiUrl, 'users/someone-else']);
  const session = { [other]: stored({ tags: ['theirs'], names: ['memos/theirs'] }) };
  const popup = await loadPopup(
    {
      userTags: async () => ['mine'],
      listMemos: async () => [{ name: 'memos/mine' }],
      getMemo: async (_, name) => ({ name, content: name })
    },
    {},
    session
  );
  await clickTags(popup);
  assert.deepEqual(tagList(popup).tags, ['mine']);
  await clickRandom(popup);
  assert.deepEqual(shown(popup), ['mine']);
  assert.deepEqual(session[other], stored({ tags: ['theirs'], names: ['memos/theirs'], ...session[other] }));
});

test('simultaneous requests for tags, and for names, share one round of loading', async () => {
  let statistics = 0,
    lists = 0;
  const popup = await loadPopup({
    userTags: async () => {
      statistics++;
      return ['a'];
    },
    listMemos: async () => {
      lists++;
      return [{ name: 'memos/a' }];
    }
  });
  const index = popup.context.MemoIndex;
  const account = { ...info, status: true };
  assert.deepEqual(
    (await Promise.all([index.tags(account), index.tags(account)])).map(tags => Array.from(tags)),
    [['a'], ['a']]
  );
  await Promise.all([index.names(account), index.names(account)]);
  assert.equal(statistics, 1);
  assert.equal(lists, 1);
});

test('a memo saved while the tags and names are loading is still there when the load lands', async () => {
  const statistics = deferred(),
    listing = deferred();
  const session = {};
  const popup = await loadPopup(
    {
      userTags: () => statistics.promise,
      listMemos: () => listing.promise,
      getMemo: async (_, name) => ({ name, content: name }),
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['fresh'] })
    },
    {},
    session
  );
  await clickTags(popup);
  await clickRandom(popup);
  await popup.context.sendText();
  await flush();
  statistics.resolve(['a']);
  listing.resolve([{ name: 'memos/older' }]);
  await flush();
  assert.deepEqual(tagList(popup).tags, ['a', 'fresh']);
  assert.deepEqual(session[key].tags, ['a', 'fresh']);
  assert.deepEqual(session[key].names, ['memos/saved', 'memos/older']);
});

test('without user statistics, a memo saved during a listing keeps its tag when the tags join that listing', async () => {
  const listing = deferred();
  const session = {};
  const popup = await loadPopup(
    {
      listMemos: () => listing.promise,
      getMemo: async (_, name) => ({ name, content: name }),
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['fresh'] })
    },
    {},
    session
  );
  await clickRandom(popup);
  await popup.context.sendText();
  await flush();
  await clickTags(popup);
  listing.resolve([{ name: 'memos/older', tags: ['a'] }]);
  await flush();
  assert.deepEqual(tagList(popup).tags, ['a', 'fresh']);
  assert.deepEqual(session[key].tags, ['a', 'fresh']);
});

test('without user statistics, the listing made for random review also serves the tags', async () => {
  let lists = 0;
  const popup = await loadPopup({
    listMemos: async () => {
      lists++;
      return [{ name: 'memos/a', tags: ['reading'] }];
    },
    getMemo: async (_, name) => ({ name, content: name })
  });
  await clickRandom(popup);
  await clickTags(popup);
  assert.deepEqual(tagList(popup).tags, ['reading']);
  assert.equal(lists, 1);
});

test('without user statistics, a tag saved after the listing is in the tags taken from that listing', async () => {
  const popup = await loadPopup({
    listMemos: async () => [{ name: 'memos/a', tags: ['reading'] }],
    getMemo: async (_, name) => ({ name, content: name }),
    createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['fresh'] })
  });
  await clickRandom(popup);
  await popup.context.sendText();
  await flush();
  await clickTags(popup);
  assert.deepEqual(tagList(popup).tags, ['fresh', 'reading']);
});

test('archived memos in a listing give neither names nor tags', async () => {
  const session = {};
  const popup = await loadPopup(
    {
      listMemos: async () => [
        { name: 'memos/kept', tags: ['kept'] },
        { name: 'memos/archived', tags: ['old'], state: 'ARCHIVED' },
        { name: 'memos/legacy', tags: ['older'], rowStatus: 'ARCHIVED' }
      ]
    },
    {},
    session
  );
  await clickTags(popup);
  assert.deepEqual(tagList(popup).tags, ['kept']);
  assert.deepEqual(session[key].names, ['memos/kept']);
});

test('archiving without user statistics lists the memos again for the next tags', async () => {
  let lists = 0;
  const popup = await loadPopup({
    listMemos: async () =>
      ++lists === 1
        ? [
            { name: 'memos/a', tags: ['gone'] },
            { name: 'memos/b', tags: ['kept'] }
          ]
        : [{ name: 'memos/b', tags: ['kept'] }],
    archiveMemo: async () => ({})
  });
  await clickTags(popup);
  assert.deepEqual(tagList(popup).tags, ['gone', 'kept']);
  await clickTags(popup);
  await popup.context.archiveMemoByName('memos/a');
  await flush();
  await clickTags(popup);
  await flush();
  assert.deepEqual(tagList(popup).tags, ['kept']);
  assert.equal(lists, 2);
});

test('without user statistics, archiving during a listing does not empty the tags that join it', async () => {
  const listing = deferred();
  const session = {};
  const popup = await loadPopup(
    {
      listMemos: () => listing.promise,
      getMemo: async (_, name) => ({ name, content: name }),
      archiveMemo: async () => ({})
    },
    {},
    session
  );
  await clickRandom(popup);
  await popup.context.archiveMemoByName('memos/gone');
  await flush();
  await clickTags(popup);
  listing.resolve([{ name: 'memos/b', tags: ['kept'] }]);
  await flush();
  assert.deepEqual(tagList(popup), { open: true, tags: ['kept'], text: '' });
  assert.deepEqual(session[key].tags, ['kept']);
  assert.equal(session[key].tagsAt, 0, 'the listing may predate the archive, so the tags are checked again next time');
});

test('changing the account closes the tag list, and tags still loading for the old account are not drawn', async () => {
  const answer = deferred();
  const popup = await loadPopup({ userTags: () => answer.promise });
  await clickTags(popup);
  assert.equal(tagList(popup).open, true);
  popup.storage.userName = 'users/someone-else';
  popup.context.chrome.storage.onChanged.emit({ userName: { newValue: 'users/someone-else' } }, 'sync');
  await flush();
  assert.equal(tagList(popup).open, false);
  answer.resolve(['theirs']);
  await flush();
  assert.deepEqual(tagList(popup), { open: false, tags: [], text: '' });
});

test('a new access token forgets the tags and names loaded with the old one', async () => {
  let statistics = 0;
  const session = { [key]: stored({ tags: ['public-only'], names: ['memos/public'] }) };
  const popup = await loadPopup(
    {
      userTags: async () => {
        statistics++;
        return ['mine', 'public-only'];
      },
      listMemos: async () => [{ name: 'memos/mine' }],
      getMemo: async (_, name) => ({ name, content: name })
    },
    {},
    session
  );
  popup.storage.apiTokens = 'renewed-pat';
  popup.context.chrome.storage.onChanged.emit({ apiTokens: { newValue: 'renewed-pat' } }, 'sync');
  await flush();
  await clickTags(popup);
  assert.deepEqual(tagList(popup).tags, ['mine', 'public-only']);
  assert.equal(statistics, 1);
  await clickRandom(popup);
  assert.deepEqual(shown(popup), ['mine']);
});

test('tags and names that were loading when the access token changed are not kept', async () => {
  const answer = deferred();
  let statistics = 0;
  const session = {};
  const popup = await loadPopup(
    {
      userTags: () => (++statistics === 1 ? answer.promise : Promise.resolve(['mine'])),
      listMemos: never
    },
    {},
    session
  );
  await clickTags(popup);
  popup.storage.apiTokens = 'renewed-pat';
  popup.context.chrome.storage.onChanged.emit({ apiTokens: { newValue: 'renewed-pat' } }, 'sync');
  await flush();
  answer.resolve(['public-only']);
  await flush();
  assert.equal(session[key].tags, null);
  await clickTags(popup);
  assert.deepEqual(tagList(popup).tags, ['mine']);
});

test('tags, random review and saving work when session storage fails or does not exist', async () => {
  for (const breakStorage of [
    chrome => {
      chrome.storage.session.get = chrome.storage.session.set = () => {
        throw new Error('storage unavailable');
      };
    },
    chrome => {
      delete chrome.storage.session;
    }
  ]) {
    let statistics = 0;
    const popup = await loadPopup({
      userTags: async () => {
        statistics++;
        return ['a'];
      },
      listMemos: async () => [{ name: 'memos/a' }],
      getMemo: async (_, name) => ({ name, content: name }),
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['fresh'] })
    });
    breakStorage(popup.context.chrome);
    await clickTags(popup);
    assert.deepEqual(tagList(popup), { open: true, tags: ['a'], text: '' });
    await clickRandom(popup);
    assert.deepEqual(shown(popup), ['a']);
    await popup.context.sendText();
    await flush();
    assert.equal(popup.messages.at(-1), 'memoSuccess');
    assert.deepEqual(tagList(popup).tags, ['a', 'fresh'], 'the page still remembers for as long as it is open');
    assert.equal(statistics, 1);
  }
});

test('recording a save or an archive never rejects, whatever happens to the index', async () => {
  const popup = await loadPopup();
  popup.context.DraftStorage.locked = () => Promise.reject(new Error('lock unavailable'));
  const index = popup.context.MemoIndex;
  const account = { ...info, status: true };
  await index.saved(account, { name: 'memos/a', tags: ['a'] });
  await index.archived(account, 'memos/a');
  await index.restored(account, 'memos/a');
  await index.forget(account, 'memos/a');
});

test('at most 20000 memo names are kept, the newest first', async () => {
  const session = {};
  const popup = await loadPopup(
    {
      listMemos: async () => Array.from({ length: 20005 }, (_, i) => ({ name: 'memos/' + i })),
      getMemo: async (_, name) => ({ name, content: name }),
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: [] })
    },
    {},
    session
  );
  await clickRandom(popup);
  assert.equal(session[key].names.length, 20000);
  assert.equal(session[key].names[0], 'memos/0');
  await popup.context.sendText();
  await flush();
  assert.equal(session[key].names.length, 20000);
  assert.equal(session[key].names[0], 'memos/saved');
});

test('a remembered index that is not in the expected form is loaded again', async () => {
  for (const junk of ['tags', { tags: 'a', names: [1, 2] }, { tags: [null] }, null]) {
    const popup = await loadPopup({ userTags: async () => ['a'] }, {}, { [key]: junk });
    await clickTags(popup);
    assert.deepEqual(tagList(popup).tags, ['a'], JSON.stringify(junk));
  }
});

test('a tag with markup characters is escaped in the list', async () => {
  const popup = await loadPopup({ userTags: async () => ['a&b<c>'] });
  await clickTags(popup);
  assert.match(popup.node('#taglist').html(), /#a&amp;b&lt;c&gt;</);
});
