import type { ReviewFinding, ReviewReport } from './types.js'
import { openBlockers } from './precheck.js'

export function formatReviewReport(report: ReviewReport): string {
  const blockers = openBlockers(report.findings).filter((item) => item.severity === 'BLOCKER')
  const majors = report.findings.filter((item) => item.severity === 'MAJOR' && item.status === 'open')
  const openNonBlocking = report.findings.filter((item) => !item.blocking && item.status === 'open').length
  const lines = [
    `Candidate: ${report.candidateId}`,
    `Digest: ${report.digest}`,
    `Risk: ${report.riskClass}`,
    `Deterministic gates: ${report.findings.some((item) => item.category === 'deterministic-gate' && item.status === 'open') ? 'FAIL' : 'PASS'}`,
    `Review: ${report.state === 'review-complete' ? 'COMPLETE' : 'CHANGES REQUIRED'}`,
    '',
  ]
  if (report.state === 'review-complete') {
    lines.push(
      `Blocking findings: 0`,
      `Open non-blocking findings: ${openNonBlocking}`,
      'Current digest verified: yes',
      `Approval status: ${report.approvalStatus}`,
    )
  } else {
    pushGroup(lines, 'BLOCKER', blockers)
    pushGroup(lines, 'MAJOR', majors)
    lines.push('', `Approval status: ${report.approvalStatus}`)
  }
  return lines.join('\n')
}

function pushGroup(lines: string[], label: string, items: readonly ReviewFinding[]): void {
  if (items.length === 0) return
  lines.push(label)
  for (const item of items) {
    lines.push(`- ${item.claim}: ${item.evidence}`)
  }
}
