#!/usr/bin/env node
/**
 * deploy.mjs — zip lambda/ and push directly to AWS Lambda
 * Usage: node deploy.mjs [function-name]
 * Default function name: baypay-handler
 */

import { LambdaClient, UpdateFunctionCodeCommand, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

const FUNCTION_NAME = process.argv[2] || 'BayPayAPI';
const ZIP_PATH      = join(__dir, '..', 'baypay-lambda.zip');
const LAMBDA_DIR    = __dir;
const REGION        = 'us-east-1';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('❌ Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY before running.');
  process.exit(1);
}

const lambda = new LambdaClient({ region: REGION });

async function main() {
  // 1. Build zip
  console.log('📦 Zipping lambda/ ...');
  execSync(
    `zip -r "${ZIP_PATH}" . --exclude "*.DS_Store" --exclude "node_modules/.cache/*"`,
    { cwd: LAMBDA_DIR, stdio: 'inherit' }
  );
  const zipBytes = readFileSync(ZIP_PATH);
  console.log(`   ${(zipBytes.length / 1024 / 1024).toFixed(1)} MB`);

  // 2. Verify function exists
  console.log(`\n🔍 Checking function "${FUNCTION_NAME}" in ${REGION} ...`);
  try {
    const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: FUNCTION_NAME }));
    console.log(`   Runtime: ${cfg.Runtime}  |  Handler: ${cfg.Handler}  |  Last modified: ${cfg.LastModified}`);
  } catch (e) {
    console.error(`\n❌ Function "${FUNCTION_NAME}" not found. Pass the correct name as an argument:\n   node deploy.mjs <function-name>`);
    process.exit(1);
  }

  // 3. Upload
  console.log('\n🚀 Uploading ...');
  const res = await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: FUNCTION_NAME,
    ZipFile: zipBytes,
  }));
  console.log(`\n✅ Deployed!`);
  console.log(`   Version:       ${res.Version}`);
  console.log(`   Code SHA-256:  ${res.CodeSha256}`);
  console.log(`   Last modified: ${res.LastModified}`);
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
