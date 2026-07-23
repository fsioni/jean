/**
 * Names the Jenkins UI shows, mirroring the Rust constants in
 * `jean-core/src/jenkins/commands.rs`. Kept in one place so renaming a job on
 * the controller is a one-line change here instead of a hunt through tooltips.
 */

/** Pipeline job whose result IS the PR's verdict (tests + build + deploys). */
export const PIPELINE_JOB = 'unified-build-test-deploy'

/** The flaky end-to-end stage — highlighted, and the one "restart" targets. */
export const FLAKY_STAGE = 'Cypress Unified'
