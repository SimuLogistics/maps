const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1100, height: 850 } });
  await p.goto('http://localhost:8766/'); await p.waitForTimeout(5000);
  const spots = JSON.parse(process.argv[2]);
  for (const [name,x,y,z] of spots) { await p.evaluate(([x,y,z]) => map.jumpTo({center:[x,y],zoom:z}), [x,y,z]); await p.waitForTimeout(4500); await p.screenshot({ path: name }); }
  await b.close();
})();
