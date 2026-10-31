import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const initialCommit = '0000000000000000000000000000000000000000';

export async function getLastSuccessfulDeploySha({
  apiUrl,
  repository,
  token,
  fetchImpl = fetch,
}) {
  if (!apiUrl || !repository || !token) {
    throw new Error('GitHub API URL, repository, and token are required');
  }
  const url = new URL(
    `repos/${repository}/actions/workflows/deploy.yml/runs`,
    `${apiUrl.replace(/\/+$/, '')}/`,
  );
  url.search = new URLSearchParams({
    branch: 'main',
    status: 'success',
    per_page: '100',
  });
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(
      `Could not read the last successful deployment: HTTP ${response.status}`,
    );
  }
  const result = await response.json();
  if (!Array.isArray(result.workflow_runs)) {
    throw new Error('GitHub returned an invalid workflow-run response');
  }
  const apiBase = `${apiUrl.replace(/\/+$/, '')}/`;
  for (const run of result.workflow_runs) {
    if (!Number.isSafeInteger(run.id) || !/^[0-9a-f]{40}$/.test(run.head_sha)) {
      throw new Error('GitHub returned an invalid successful workflow run');
    }
    const jobsUrl = new URL(
      `repos/${repository}/actions/runs/${run.id}/jobs`,
      apiBase,
    );
    jobsUrl.search = new URLSearchParams({ per_page: '100' });
    const jobsResponse = await fetchImpl(jobsUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!jobsResponse.ok) {
      throw new Error(
        `Could not read deployment job results: HTTP ${jobsResponse.status}`,
      );
    }
    const jobs = await jobsResponse.json();
    if (!Array.isArray(jobs.jobs)) {
      throw new Error('GitHub returned an invalid workflow-jobs response');
    }
    if (
      jobs.jobs.some(
        (job) =>
          job.name === 'Deploy production' && job.conclusion === 'success',
      )
    ) {
      return run.head_sha;
    }
  }
  return initialCommit;
}

export async function getCurrentMainSha({
  apiUrl,
  repository,
  token,
  fetchImpl = fetch,
}) {
  if (!apiUrl || !repository || !token) {
    throw new Error('GitHub API URL, repository, and token are required');
  }
  const response = await fetchImpl(
    new URL(
      `repos/${repository}/commits/main`,
      `${apiUrl.replace(/\/+$/, '')}/`,
    ),
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not read current main commit: HTTP ${response.status}`,
    );
  }
  const result = await response.json();
  if (!/^[0-9a-f]{40}$/.test(result.sha)) {
    throw new Error('GitHub returned an invalid main commit SHA');
  }
  return result.sha;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const sha = await getLastSuccessfulDeploySha({
    apiUrl: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
  process.stdout.write(`${sha}\n`);
}
