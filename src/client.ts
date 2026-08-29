import { TrueForge } from '@truefoundry/trueforge-sdk';

export const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
export const MODEL = process.env.TRUEFORGE_MODEL ?? 'openai/gpt-5-5';

export const client = new TrueForge({
  baseUrl: BASE_URL,
  timeoutInSeconds: 600,
  // Local standalone mode has no login; OIDC deployments need an IdP id token.
  token: process.env.TRUEFORGE_TOKEN,
});
