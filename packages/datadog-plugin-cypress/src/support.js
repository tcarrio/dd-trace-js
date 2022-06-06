/* eslint-disable */
before(() => {
  cy.task('dd:before', Cypress.mocha.getRootSuite().file)
})

beforeEach(() => {
  cy.task('dd:beforeEach', {
    testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file
  }).then(traceId => {
    Cypress.env('traceId', traceId)
  })
})

after(() => {
  cy.window().then(win => {
    win.dispatchEvent(new Event('beforeunload'))
    cy.task('dd:after', 'pass') // get actual status
  })
})


afterEach(() => {
  cy.window().then(win => {
    const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
    const testInfo = {
      testName: currentTest.fullTitle(),
      testSuite: Cypress.mocha.getRootSuite().file,
      state: currentTest.state,
      error: currentTest.err,
    }
    if (win.DD_RUM) {
      testInfo.isRUMActive = true
    }
    cy.task('dd:afterEach', testInfo)
  })
})
