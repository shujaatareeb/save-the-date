// Asks the live page the question a link preview asks it.
//
//   node test/preview.mjs                      # the real address
//   node test/preview.mjs http://localhost:8734/
//
// This is the one failure the other harnesses cannot see. Everything here can
// be perfect in a browser — the card, the reveal, the og.png — and a link
// pasted into a chat still arrives as bare blue text, because what decides
// that is a header and a meta tag, not a rendering.
//
// It came from a real one: the page carried `<meta name="robots"
// content="noindex,nofollow">` from its first commit. Search engines read that
// and stay away, which was the point — but the preview fetchers read it too,
// and Slack, Apple and Meta all take it as "do not touch this page". No card
// on any of them, no title, no description, nothing to tell from the outside
// because the page itself served perfectly to anyone who asked.

const URL_UNDER_TEST = process.argv[2] || 'https://misbahxareeb.us.com/';

// what actually knocks on the door when a link is pasted into a chat
const CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const problems = [];
const check = (ok, complaint) => { if (!ok) problems.push(complaint); };

const res = await fetch(URL_UNDER_TEST, { headers: { 'user-agent': CRAWLER }, redirect: 'follow' });
check(res.ok, `the page answered ${res.status} to a crawler`);
const html = await res.text();

// Only the head is ever read for this, and og tags below the first 8KB or so
// are read by some fetchers and not others. Look where they have to be.
const head = html.slice(0, html.indexOf('</head>') + 1 || 8192);

const meta = (attr, key) => {
  const m = head.match(new RegExp(`<meta[^>]*${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'))
         || head.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`, 'i'));
  return m ? m[1] : null;
};

const og = {
  title: meta('property', 'og:title'),
  description: meta('property', 'og:description'),
  image: meta('property', 'og:image'),
  url: meta('property', 'og:url'),
};
for (const [k, v] of Object.entries(og)) check(v, `og:${k} is missing`);

// The tag that started this. `name="robots"` speaks to every crawler there is,
// and the preview fetchers are crawlers. Aim it at the search engines by name
// and they still stay out of the index while a shared link keeps its card.
const blanket = meta('name', 'robots');
check(
  !(blanket && /noindex/i.test(blanket)),
  `<meta name="robots" content="${blanket}"> tells every crawler to leave the page alone, ` +
  'preview fetchers included — scope it to googlebot/bingbot instead',
);

if (og.image) {
  const abs = new global.URL(og.image, res.url).href;
  check(abs.startsWith('https://'), `og:image is not https (${abs})`);
  const img = await fetch(abs, { headers: { 'user-agent': CRAWLER } });
  const type = img.headers.get('content-type') || '';
  const bytes = Number(img.headers.get('content-length') || 0);
  check(img.ok, `og:image answered ${img.status}`);
  check(type.startsWith('image/'), `og:image came back as ${type}`);
  // Meta and Apple both stop well short of this; it is a ceiling, not a target.
  check(bytes < 5_000_000, `og:image is ${(bytes / 1024 / 1024).toFixed(1)}MB`);
  console.log(`og:image  ${abs}\n          ${img.status} ${type} ${(bytes / 1024).toFixed(0)}KB`);
}

console.log(`og:title  ${og.title}`);
console.log(problems.length ? '\n' + problems.join('\n') : '\nclean: a crawler gets a full card');
// Set rather than exit(): fetch leaves its sockets open a moment longer, and
// tearing the loop down under them trips an assertion inside libuv on Windows
// that turns a plain red run into a crash report.
process.exitCode = problems.length ? 1 : 0;
