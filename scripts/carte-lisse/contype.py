# a junction connector between two roads of different types (motorway exit onto a local road)
# takes the lower type, so the motorway colour stops where the motorway does (base3 in place)
import json,math,numpy as np,collections
from shapely.geometry import LineString,Point
from shapely.strtree import STRtree
FULL='/tmp/claude-0/full'
SC=np.array([0.00025048*math.cos(math.radians(45))/math.cos(math.radians(47)),0.000175])
RANK={'local':0,'divided':1,'freeway':2}
base=json.load(open(FULL+'/base3.geojson')); F=base['features']
R=[(LineString(np.asarray(f['geometry']['coordinates'])/SC),f['properties'].get('roadType')) for f in F
   if f['properties'].get('type')=='road' and f['properties'].get('pf')==0 and f['properties'].get('roadType') in RANK
   and f['geometry']['type']=='LineString' and len(f['geometry']['coordinates'])>1]
t=STRtree([g for g,_ in R]); c=collections.Counter()
for f in F:
    p=f['properties']
    if p.get('pf')!=2 or p.get('roadType') not in RANK: continue
    m=np.asarray(f['geometry']['coordinates'])/SC; ts=[]
    for e in (m[0],m[-1]):
        k=t.query_nearest(Point(e),max_distance=3); ts.append(R[k[0]][1] if len(k) else None)
    if None in ts: continue
    low=min(ts,key=RANK.get)
    if RANK[low]<RANK[p['roadType']]: c[(p['roadType'],low)]+=1; p['roadType']=low
print(c)
json.dump(base,open(FULL+'/base3.geojson','w'),separators=(',',':'))
