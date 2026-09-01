import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { CapabilityCenterWorkspace, implementationPane } from '../web/src/CapabilityCenterWorkspace.js'
import { projectCapabilityPortfolio } from '../src/domain/capability-portfolio/index.js'

describe('Capability Center workspace', () => {
  it('maps existing capability standards into one user-facing entry point', () => {
    const markup = renderToStaticMarkup(createElement(CapabilityCenterWorkspace, {
      locked: false,
      focusCapabilityId: 'skill:skill-1',
      navigate() {},
      defineCapability() {},
      askUnplug() {},
      cancelUnplug() {},
      confirmUnplug() {},
      skillAction() {},
      view: {
        plugins: [{
          id: 'uninst-generated/review@0.1.0', owner: 'generated/review', version: '0.1.0', provenance: 'generated',
          candidateId: 'ext-1', digest: 'digest', capabilities: ['review.read'], tools: ['review'], mounted: true,
          registryGeneration: 1, dependency: { severity: 'optional', dependents: [{ owner: 'generated/report', version: '0.1.0', requiredCapability: 'review.read', kind: 'optional' }] }, uninstallable: true,
        }, {
          id: 'uninst-managed/ui-control-surface@0.1.1', owner: 'managed/ui-control-surface', version: '0.1.1', provenance: 'generated',
          capabilities: ['ui.markdown'], tools: ['markdown_render'], mounted: true, registryGeneration: 1,
          dependency: { severity: 'none', dependents: [] }, uninstallable: true,
        }],
        extensions: [{
          id: 'ext-1', owner: 'generated/review', version: '0.1.0', provenance: 'generated', capabilities: ['review.read'], tools: ['review'],
          lifecycle: 'ACTIVE', registryStatus: 'active', mounted: true, eligibilityOk: true, eligibilityDenials: [], newerAuthoritative: false,
          digest: 'digest', validationPassed: true, reviewState: 'review-complete', approvalDecision: 'approved-for-exact-diff',
        }, {
          id: 'ext-system', owner: 'managed/ui-control-surface', version: '0.1.1', provenance: 'generated', capabilities: ['ui.markdown'], tools: ['markdown_render'],
          lifecycle: 'ACTIVE', registryStatus: 'active', mounted: true, eligibilityOk: true, eligibilityDenials: [], newerAuthoritative: false,
        }, {
          id: 'ext-pending', owner: 'generated/pending-probe', version: '0.1.0', provenance: 'generated', capabilities: ['pending.probe'], tools: [],
          lifecycle: 'APPROVAL_REQUIRED', registryStatus: 'absent', mounted: false, eligibilityOk: false, eligibilityDenials: ['review-required'], newerAuthoritative: false,
        }, {
          id: 'ext-disabled', owner: 'generated/disabled-helper', version: '0.1.0', provenance: 'generated', capabilities: ['helper.read'], tools: [],
          lifecycle: 'DISABLED_REACTIVATABLE', registryStatus: 'disabled', mounted: false, eligibilityOk: true, eligibilityDenials: [], newerAuthoritative: false,
        }],
        skills: [{
          id: 'skill-1', name: 'review-style', version: '0.1.0', profile: 'assistant', provenance: 'user', origin: 'user', lifecycle: 'active',
          sealed: true, modelInvocable: true, userInvocable: true, description: 'Review style.', resources: [], validationPassed: true,
          reviewComplete: true, digest: 'digest', dependsOn: [], dependents: [], system: false, generation: 1,
          approvalDecision: 'approved-for-exact-diff',
        }, {
          id: 'skill-system', name: 'system-runtime-guide', version: '0.1.0', profile: 'assistant', provenance: 'managed', origin: 'profile', lifecycle: 'active',
          sealed: true, modelInvocable: true, userInvocable: false, description: 'Internal instructions.', resources: [], validationPassed: true,
          reviewComplete: true, digest: 'system-digest', dependsOn: [], dependents: [], system: true, generation: 1,
        }],
        skillCatalog: { state: 'ok', failed: [], recoveryRequired: false },
      },
      tools: {
        summary: { total: 2, hostManaged: 1, generatedGoverned: 1, thirdPartyGoverned: 0 },
        tools: [],
      },
      workflows: {
        summary: { total: 2, hostManaged: 1, generatedGoverned: 1, thirdPartyGoverned: 0 },
        workflows: [{
          name: 'review-flow', title: 'Review Flow', description: 'Run the independent review.', owner: 'generated/review', version: '0.1.0', provenance: 'generated', governance: 'generated-governed', engine: 'dsh-workflow', runtime: 'isolated-process', lifecycle: 'active', intent: 'read', phases: [], inputFields: [], maxTotalAgents: 2,
        }, {
          name: 'internal-boot', title: 'Internal Boot Workflow', description: 'Host plumbing.', owner: 'managed/runtime', version: '0.4.0', provenance: 'managed', governance: 'host-managed', engine: 'dsh-workflow', runtime: 'isolated-process', lifecycle: 'active', intent: 'read', phases: [], inputFields: [], maxTotalAgents: 1,
        }],
      },
    }))

    assert.match(markup, /CAPABILITY CENTER/)
    assert.match(markup, /Review/)
    assert.doesNotMatch(markup, /Calendar|USER CAPABILITY/)
    assert.match(markup, /Disabled Helper/)
    assert.match(markup, /EXTENSION/)
    assert.match(markup, /WORKFLOW/)
    assert.match(markup, /TOOL/)
    assert.match(markup, /SKILL/)
    assert.match(markup, /UNPLUG/)
    assert.match(markup, /DELIVERY EVIDENCE/)
    assert.match(markup, /VALIDATED · INDEPENDENT REVIEW COMPLETE · HUMAN APPROVED · ACTIVE/)
    assert.match(markup, /EXACT REVISION/)
    assert.doesNotMatch(markup, /Ui Control Surface|Pending Probe|system-runtime-guide|Internal Boot Workflow/)
    assert.match(markup, /NEED.*PROPOSE.*CONSENT.*BUILD.*VALIDATE.*REVIEW.*APPROVE.*ACTIVATE/s)
    assert.match(markup, /CAPABILITY IS THE PRODUCT OBJECT/)
    assert.match(markup, /DESCRIBE WHAT YOU NEED/)
    assert.match(markup, /INSTALLED/)
    assert.match(markup, /data-capability-id="skill:skill-1"[^>]*data-capability-focus="target"/)
    assert.match(markup, /data-capability-id="skill:skill-1"[\s\S]*DELIVERY EVIDENCE/)
    assert.doesNotMatch(markup, /capability-unplug-dialog/)
  })

  it('routes each first-class implementation to its own technical surface', () => {
    const portfolio = projectCapabilityPortfolio({
      view: {
        plugins: [{
          id: 'workflow-plugin', owner: 'generated/workflow-review', version: '0.1.0', provenance: 'generated',
          capabilities: ['review.flow'], tools: [], mounted: true, registryGeneration: 1,
          dependency: { severity: 'none', dependents: [] }, uninstallable: true,
        }, {
          id: 'tool-plugin', owner: 'generated/risk-tool', version: '0.1.0', provenance: 'generated',
          capabilities: ['risk.check'], tools: ['risk_check'], mounted: true, registryGeneration: 1,
          dependency: { severity: 'none', dependents: [] }, uninstallable: true,
        }],
        extensions: [],
        skills: [{
          id: 'skill-1', name: 'review-style', version: '0.1.0', profile: 'assistant', provenance: 'user', origin: 'user', lifecycle: 'active',
          sealed: true, modelInvocable: true, userInvocable: true, description: 'Review style.', resources: [], validationPassed: true,
          reviewComplete: true, approvalDecision: 'approved-for-exact-diff', digest: 'skill-digest', dependsOn: [], dependents: [], system: false, generation: 1,
        }],
      },
      tools: {
        summary: { total: 1, hostManaged: 0, generatedGoverned: 1, thirdPartyGoverned: 0 },
        tools: [{ name: 'risk_check', description: 'Check risk.', owner: 'generated/risk-tool', version: '0.1.0', provenance: 'generated', governance: 'generated-governed', runtime: 'isolated', lifecycle: 'active', capabilities: ['risk.check'], permissions: [], parameters: [] }],
      },
      workflows: {
        summary: { total: 1, hostManaged: 0, generatedGoverned: 1, thirdPartyGoverned: 0 },
        workflows: [{ name: 'workflow-review', title: 'Workflow Review', description: 'Review.', owner: 'generated/workflow-review', version: '0.1.0', provenance: 'generated', governance: 'generated-governed', engine: 'dsh-workflow', runtime: 'isolated-process', lifecycle: 'active', intent: 'read', phases: [], inputFields: [], maxTotalAgents: 1 }],
      },
    })

    const workflow = portfolio.cards.find((item) => item.workflows.length > 0)
    const tool = portfolio.cards.find((item) => item.tools.length > 0)
    const skill = portfolio.cards.find((item) => item.implementation.includes('skill'))
    assert.equal(workflow && implementationPane(workflow), 'workflows')
    assert.equal(tool && implementationPane(tool), 'tools')
    assert.equal(skill && implementationPane(skill), 'extensions')
  })
})
