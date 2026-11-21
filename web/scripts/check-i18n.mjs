import { readFileSync } from 'node:fs';
const locales = ['zh-CN', 'zh-HK', 'en'];
const flatten = (object, prefix = '') => Object.entries(object).flatMap(([key, value]) => typeof value === 'object' && value !== null ? flatten(value, prefix + key + '.') : [prefix + key]).sort();
const keys = locales.map(locale => flatten(JSON.parse(readFileSync(new URL('../src/i18n/locales/' + locale + '/common.json', import.meta.url), 'utf8'))));
if (keys.some(value => JSON.stringify(value) !== JSON.stringify(keys[0]))) { console.error('Locale key sets differ'); process.exit(1); }
console.log('Locale keys match');
