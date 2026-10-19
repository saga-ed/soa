#!/usr/bin/env node
import { defaultDeps, runRatchet } from './ratchet.js';

process.exitCode = runRatchet(process.argv.slice(2), defaultDeps(process.env));
