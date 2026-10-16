import json,sys,math
B=[float(x) for x in sys.argv[1].split(',')]
def inb(cs): return any(B[0]<=x<=B[2] and B[1]<=y<=B[3] for x,y in cs)
paths={d['token']:d['path'] for d in json.load(open('/mnt/user-data/uploads/Dev/tools/snapshots/ets2/1.61.1.1/.cache/parser/europe-prefabDescriptions.json'))}
uids=set()
for f in json.load(open('full/europe-prefab-curves.geojson'))['features']:
  ls=[l for l in f['geometry']['coordinates'] if inb(l)]
  if ls: uids.add(f['properties']['prefabUid']); print('LANES',f['properties']['prefabUid'],paths.get(f['properties']['prefabToken']),len(ls))
for f in json.load(open('full/connectors.geojson'))['features']:
  p=f['properties']
  if p['prefabUid'] in uids: c=f['geometry']['coordinates']; print('CON',p['prefabUid'],p['i'],p['j'],[round(v,5) for v in c[0]],[round(v,5) for v in c[-1]],'hint',[round(v,5) for v in p['sh']],[round(v,5) for v in p['eh']])
for f in json.load(open('full/base2.geojson'))['features']:
  c=f['geometry']['coordinates']
  if f['geometry']['type']=='LineString' and inb(c) and f['properties'].get('type')=='road': p=f['properties'];print('ROAD',p.get('pf'),p.get('leftLanes'),p.get('rightLanes'),[round(v,5) for v in c[0]],[round(v,5) for v in c[-1]])
