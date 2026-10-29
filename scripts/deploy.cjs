const fs = require('fs');
const path = require('path');

async function main() {
  const hre = require('hardhat');
  console.log('Deploying CrowdFundingLedger to Ethereum network...');

  const CrowdFundingLedger = await hre.ethers.getContractFactory('CrowdFundingLedger');
  const contract = await CrowdFundingLedger.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`CrowdFundingLedger deployed to address: ${address}`);

  // Save deployed address for frontend
  const deployData = {
    address,
    network: hre.network.name,
    timestamp: new Date().toISOString()
  };

  const outputPath = path.join(__dirname, '../src/artifacts/deployedAddress.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(deployData, null, 2));
  console.log(`Deployment info saved to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
