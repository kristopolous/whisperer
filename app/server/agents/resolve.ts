/** Work out what the person actually typed in.
 *
 *  The input box says "company name or website" and takes anything: a brand, a
 *  domain, a GitHub URL, a description. Everything downstream then depends on
 *  what it was read as — the title on screen, the term thirty searches quote,
 *  which repository gets diagnosed. Getting it wrong is not a cosmetic problem:
 *  a scan for "gimp image editor" searched for that exact phrase and returned
 *  two results, and pasting a GitHub URL produced a scan titled "Github".
 *
 *  Nobody should be condemned by what they typed in a box. This settles the
 *  identity once, at the start, and the rest of the pipeline works from the
 *  answer rather than from the string.
 *
 *  Deterministic code gathers the evidence — repository metadata from the
 *  host's API, search results for the name — and the model only decides what
 *  that evidence adds up to. It gets no tools, because "fetch this repo's
 *  metadata" is a fixed operation.
 *
 *  The two lists are the part worth having. `aliases` catches a product
 *  discussed under more than one name; `excludeTerms` names the unrelated
 *  things that share it — the reason a scan for "Bolt" returned a smartwatch
 *  company, and one for "gimp" returned an entirely different kind of website.
 */

import { subjectSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const RESOLVE_INSTRUCTIONS = `You identify what a person meant when they typed a name into a brand-monitoring tool.

You are given exactly what they typed, plus whatever could be found about it automatically: repository metadata if it looked like a repository URL, and search results otherwise. Decide what the subject actually is.

What matters:
- \`name\` is what to put on screen. Use the name its own users and documentation use, capitalised the way they capitalise it. Not a URL, not a repository path, not a description.
- \`searchTerm\` is the single term that will be quoted into dozens of web searches. It must be what people actually write when discussing it — usually one word. A descriptive phrase nobody types ("gimp image editor", "the supabase database") returns nothing, because it is not a phrase that occurs.
- \`aliases\` are other names for the SAME thing: a former name, an abbreviation, a repository name that differs from the product name. Leave it empty rather than padding it.
- \`excludeTerms\` are the collisions. If the name is also an ordinary word, a person, or a different product, name those here so a search can be told what it is not. This is the difference between finding complaints about a product and finding a sprinter, a car, and a slang term. Think about what else the word means before you answer.
- \`repo\` only if you actually know it from the evidence. Do not guess an owner or a URL.
- \`confidence\` is low when the evidence is thin or the name is ambiguous. Say so rather than committing.

Do not invent a homepage, a repository or an alias that was not in the evidence you were given. An invented URL is worse than an empty string, because everything downstream will try to use it.`;

export const resolveAgent: AgentDefinition = {
  name: 'whisperer-resolve',
  title: 'Resolve',
  description: 'Turns whatever was typed into a subject: what to call it, what to search for, and what it is not.',
  surface: 'stage',
  stage: 'presence',
  instructions: RESOLVE_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message gives the raw input and whatever evidence could be '
    + 'gathered about it — repository metadata, search results, or nothing at all.',
  schema: subjectSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
