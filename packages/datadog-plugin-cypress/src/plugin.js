const {
  TEST_STATUS,
  TEST_IS_RUM_ACTIVE,
  TEST_CODE_OWNERS,
  getTestEnvironmentMetadata,
  CI_APP_ORIGIN,
  getTestParentSpan,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getTestCommonTags,
  getTestSuiteCommonTags,
  getTestSessionCommonTags,
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')

const { ORIGIN_KEY } = require('../../dd-trace/src/constants')

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getTestSpanMetadata (tracer, testName, testSuite, cypressConfig) {
  const childOf = getTestParentSpan(tracer)

  const commonTags = getTestCommonTags(testName, testSuite, cypressConfig.version)

  return {
    childOf,
    ...commonTags
  }
}

function getTestSessionSpanMetadata (tracer, command) {
  const childOf = getTestParentSpan(tracer)

  const commonTags = getTestSessionCommonTags(command, tracer._version)

  return {
    childOf,
    ...commonTags
  }
}

module.exports = (on, config) => {
  const tracer = require('../../dd-trace')
  const testEnvironmentMetadata = getTestEnvironmentMetadata('cypress')

  const codeOwnersEntries = getCodeOwnersFileEntries()

  let activeSpan = null
  let sessionSpan = null
  let activeSuiteSpan = null

  on('before:run', () => { // get test command here
    const {
      childOf,
      resource,
      ...testSessionMetadata
    } = getTestSessionSpanMetadata(tracer, 'yarn test') // dumb command

    sessionSpan = tracer.startSpan('cypress.test_session', {
      childOf,
      tags: {
        [ORIGIN_KEY]: CI_APP_ORIGIN,
        ...testSessionMetadata,
        ...testEnvironmentMetadata
      }
    })
  })

  on('after:run', () => {
    sessionSpan.setTag(TEST_STATUS, 'pass') // get actual status
    sessionSpan.finish()
    finishAllTraceSpans(sessionSpan)
    return new Promise(resolve => {
      tracer._tracer._exporter._writer.flush(() => resolve(null))
    })
  })
  on('task', {
    'dd:before': (testSuite) => {
      const testSuiteMetadata = getTestSuiteCommonTags(tracer._version, testSuite)
      activeSuiteSpan = tracer.startSpan('cypress.test_suite', {
        childOf: sessionSpan,
        tags: {
          ...testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      return null
    },
    'dd:after': (status) => {
      activeSuiteSpan.setTag(TEST_STATUS, status)
      activeSuiteSpan.finish()
      return null
    },
    'dd:beforeEach': (test) => {
      const { testName, testSuite } = test

      const {
        childOf,
        resource,
        ...testSpanMetadata
      } = getTestSpanMetadata(tracer, testName, testSuite, config)

      const codeOwners = getCodeOwnersForFilename(testSuite, codeOwnersEntries)

      if (codeOwners) {
        testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      if (!activeSpan) {
        activeSpan = tracer.startSpan('cypress.test', {
          childOf: tracer.extract('text_map', {
            'x-datadog-trace-id': sessionSpan.context()._traceId.toString(10),
            'x-datadog-parent-id': activeSuiteSpan.context()._spanId.toString(10)
          }),
          tags: {
            [ORIGIN_KEY]: CI_APP_ORIGIN,
            ...testSpanMetadata,
            ...testEnvironmentMetadata
          }
        })
      }
      return activeSpan ? activeSpan._spanContext._traceId.toString(10) : null
    },
    'dd:afterEach': (test) => {
      const { state, error, isRUMActive } = test
      if (activeSpan) {
        activeSpan.setTag(TEST_STATUS, CYPRESS_STATUS_TO_TEST_STATUS[state])
        if (error) {
          activeSpan.setTag('error', error)
        }
        if (isRUMActive) {
          activeSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
        }
        activeSpan.finish()
      }
      activeSpan = null
      return null
    },
    'dd:addTags': (tags) => {
      if (activeSpan) {
        activeSpan.addTags(tags)
      }
      return null
    }
  })
}
