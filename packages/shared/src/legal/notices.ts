export type NoticesSection = {
  readonly title: string;
  readonly body: readonly string[];
};

export const DELEGENT_NOTICES_TITLE = 'Delegent AI Open Source Notices';
export const DELEGENT_NOTICES_UPDATED = '25 September 2026';

export const DELEGENT_NOTICES_INTRO =
  "Delegent AI is built with the help of open-source software, and we are grateful to the people and communities who create and maintain it. This page provides the attribution and licence notices for the open-source components we rely on. If you would like the full text of any licence not reproduced here, contact us at admin@example.com.";

export const DELEGENT_NOTICES_SECTIONS: readonly NoticesSection[] = [
  {
    title: 'Hermes Agent (our earlier AI engine)',
    body: [
      "Until September 2026, Delegent AI's coworker ran on Hermes Agent, an open-source AI agent framework. It now runs on the Cloudflare Agents SDK, one of the libraries described below. We used Hermes Agent under the terms of the MIT License, and we reproduce its copyright notice and permission notice in full below.",
      'MIT License',
      'Copyright (c) 2025 Nous Research',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
      'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    ],
  },
  {
    title: 'Airport data',
    body: [
      'To work out flight distances for Money Finder, we use the airport dataset in airport-data-js by Aashish Vivekanand (https://airportdata.dev/), licensed under the Creative Commons Attribution 4.0 International licence (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). We use the data unmodified. Distances between airports are calculated with geolib by Manuel Bieh, under the MIT License.',
    ],
  },
  {
    title: 'Other open-source software',
    body: [
      'Our apps and services are also built with widely used open-source frameworks and libraries, including React, React Native, Expo, Vite, the Cloudflare Agents SDK, the AI SDK, and others. Each is provided under its own open-source licence, most commonly the MIT License, and we use them in accordance with those licences.',
      'This list covers the principal components. A more detailed inventory of the open-source packages we use, with their licences, is available on request from admin@example.com.',
    ],
  },
];
