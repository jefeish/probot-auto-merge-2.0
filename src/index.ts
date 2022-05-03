import { Application, Context } from 'probot'
import { loadConfig } from './config'
import { WorkerContext } from './models'
import Raven from 'raven'
import { RepositoryWorkers } from './repository-workers'
import sentryStream from 'bunyan-sentry-stream'
import { RepositoryReference, PullRequestReference } from './github-models'
import myAppId from './myappid'
import { flatten } from './utils'
import { GitHubAPI } from 'probot/lib/github'
import { rawGraphQLQuery } from './github-utils'

/**
 *
 * @param options
 */
async function getWorkerContext (options: {app: Application, context: Context, installationId: number}): Promise<WorkerContext> {
  const { app, context, installationId } = options
  const config = await loadConfig(context)
  const log = app.log
  const createGitHubAPI = async () => {
    return app.auth(installationId, log)
  }
  return {
    createGitHubAPI,
    log,
    config
  }
}

/**
 *
 * @param options
 * @param fn
 */
async function useWorkerContext (options: {app: Application, context: Context, installationId: number}, fn: (WorkerContext: WorkerContext) => Promise<void>): Promise<void> {
  await Raven.context({
    tags: {
      owner: options.context.payload.repository.owner.login,
      repository: `${options.context.payload.repository.owner.login}/${options.context.payload.repository.name}`
    },
    extra: {
      event: options.context.event
    }
  }, async () => {
    const workerContext = await getWorkerContext(options)
    await fn(workerContext)
  })
}

/**
 * @function setupSentry
 * @description
 *    open-source application monitoring platform that helps you
 *    identify issues in real-time.
 *    https://blog.sentry.io/2018/03/06/the-sentry-workflow
 *
 * @param app
 */
function setupSentry (app: Application) {
  if (process.env.NODE_ENV !== 'production') {
    Raven.disableConsoleAlerts()
  }
  Raven.config(process.env.SENTRY_DSN2, {
    captureUnhandledRejections: true,
    tags: {
      version: process.env.HEROKU_RELEASE_VERSION as string
    },
    release: process.env.SOURCE_VERSION,
    environment: process.env.NODE_ENV || 'development',
    autoBreadcrumbs: {
      console: true,
      http: true
    }
  }).install()

  app.log.target.addStream(sentryStream(Raven))
}

/**
 * @description
 *    Application entry point
 */
export = (app: Application) => {
  setupSentry(app)
  const repositoryWorkers = new RepositoryWorkers(
    onPullRequestError
  )

  /**
   * @function onPullRequestError
   * @description
   *
   * @param pullRequest
   * @param error
   */
  function onPullRequestError (pullRequest: PullRequestReference, error: any) {
    const repositoryName = `${pullRequest.owner}/${pullRequest.repo}`
    const pullRequestName = `${repositoryName}#${pullRequest.number}`
    Raven.captureException(error, {
      tags: {
        owner: pullRequest.owner,
        repository: repositoryName
      },
      extra: {
        pullRequest: pullRequestName
      }
    })
    console.error(`Error while processing pull request ${pullRequestName}:`, error)
  }

  /**
   *
   * @function handlePullRequests
   * @description
   *    process PR events
   *
   * @param app
   * @param context
   * @param installationId
   * @param repository
   * @param pullRequestNumbers
   */
  async function handlePullRequests (app: Application, context: Context, installationId: number, repository: RepositoryReference, pullRequestNumbers: number[]) {
    await useWorkerContext({ app, context, installationId }, async (workerContext) => {
      for (const pullRequestNumber of pullRequestNumbers) {
        repositoryWorkers.queue(workerContext, {
          owner: repository.owner,
          repo: repository.repo,
          number: pullRequestNumber
        })
      }
    })
  }

  // --------------------------------------------------------------------------
  // Function:
  // Description:
  // --------------------------------------------------------------------------
  async function getAssociatedPullRequests (github: GitHubAPI, { owner, repo, branchName }: { owner: String, repo: string, branchName: string }): Promise<{ owner: string, repo: string, number: number }[]> {
    const result = await rawGraphQLQuery(github, `
      query($owner: String!, $repo: String!, $refQualifiedName: String!) {
        repository(owner: $owner, name: $repo) {
          ref(qualifiedName: $refQualifiedName) {
            associatedPullRequests(first: 10) {
              nodes {
                number
                repository {
                  name
                  owner {
                    login
                  }
                }
              }
            }
          }
        }
      }
    `, {
      owner: owner,
      repo: repo,
      refQualifiedName: `refs/heads/${branchName}`
    }, {})
    if (!result.data) { return [] }
    return result.data.repository.ref.associatedPullRequests.nodes.map((node: any) => ({
      number: node.number,
      repo: node.repository.name,
      owner: node.repository.owner.login
    }))
  }

  // --------------------------------------------------------------------------
  // Description:
  //    Define event types to react 'on'
  // --------------------------------------------------------------------------
  app.on([
    'status'
  ], async context => {
    const branches = context.payload.branches as { name: string }[]
    const validBranches = branches.filter(branch => branch.name !== 'master')
    const pullRequestResponses = await Promise.all(validBranches.map(branch =>
      getAssociatedPullRequests(context.github, {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        branchName: branch.name
      })
    ))

    const pullRequests = flatten(pullRequestResponses)
    await Promise.all(pullRequests.map(pullRequest => {
      const repositoryReference = {
        owner: pullRequest.owner,
        repo: pullRequest.repo
      }
      return handlePullRequests(app, context, context.payload.installation.id, repositoryReference, [pullRequest.number])
    }))
  })

  app.on([
    'pull_request.opened',
    'pull_request.edited',
    'pull_request.reopened',
    'pull_request.synchronize',
    'pull_request.labeled',
    'pull_request.unlabeled',
    'pull_request.reopened',
    'pull_request_review.submitted',
    'pull_request_review.edited',
    'pull_request_review.dismissed'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, [context.payload.pull_request.number])
  })

  app.on([
    'check_run.created',
    'check_run.completed'
  ], async context => {
    if (context.payload.check_run.check_suite.app.id === myAppId) {
      return
    }

    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_run.pull_requests.map((pullRequest: any) => pullRequest.number))
  })

  app.on([
    'check_run.rerequested',
    'check_run.requested_action'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_run.pull_requests.map((pullRequest: any) => pullRequest.number))
  })

  app.on([
    'check_suite.requested',
    'check_suite.rerequested'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_suite.pull_requests.map((pullRequest: any) => pullRequest.number))
  })

  app.on([
    'check_suite.completed'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_suite.pull_requests.map((pullRequest: any) => pullRequest.number))
  })
}
