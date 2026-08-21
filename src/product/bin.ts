#!/usr/bin/env node
import { runProductCli } from './cli.js'

process.exitCode = await runProductCli(process.argv.slice(2))
