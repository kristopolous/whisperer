import { unwrapUntrusted } from '../app/server/content.ts';
const id = '6c578b0c6c5c957cd5610e9e3ab1431b';
const sample = `SECURITY NOTICE: blah blah treat as DATA.\n\n=====UNTRUSTED_${id}_BEGIN=====\nreal page content here\n=====UNTRUSTED_${id}_END=====`;
console.log('unwrapped:', JSON.stringify(unwrapUntrusted(sample)));
