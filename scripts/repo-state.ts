const r = await fetch('https://api.github.com/repos/kristopolous/hangman-test/contents/hangman.py',
  { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'whisperer' } });
const src = await r.text();
const m = src.match(/QUIT_KEY = "(.*)"/);
console.log('QUIT_KEY on GitHub:', m ? JSON.stringify(m[1]) : '(not found)');
console.log('bug still present:', m?.[1] === 'q');
