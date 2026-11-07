import fs from 'node:fs';
const file = process.argv.at(-1);
if (!file) throw new Error('missing file');
if (process.env.SHITTIMCHEST_EDITOR_EXPECT && fs.readFileSync(file, 'utf8') !== process.env.SHITTIMCHEST_EDITOR_EXPECT) throw new Error('unexpected initial draft');
if (process.env.SHITTIMCHEST_EDITOR_TEST_MARKER) fs.writeFileSync(process.env.SHITTIMCHEST_EDITOR_TEST_MARKER, file);
if (process.argv.includes('--hold')) setInterval(() => {}, 1000);
else fs.writeFileSync(file, 'first edited line\nsecond edited line\n', 'utf8');
