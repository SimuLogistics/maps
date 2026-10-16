import json,sys
from shapely.geometry import shape,box
B=box(*[float(x) for x in sys.argv[1].split(',')])
for name,path in (('ORIG','/tmp/claude-0/out-v/ets2.geojson'),('NEW','/tmp/claude-0/full/base2.geojson')):
  for f in json.load(open(path))['features']:
    p=f['properties']
    if p.get('type')=='road' and shape(f['geometry']).intersects(B):
      c=f['geometry']['coordinates']; print(name,f.get('id'),p.get('pf'),p.get('roadType'),len(c),[round(v,5) for v in c[0]],[round(v,5) for v in c[-1]])
