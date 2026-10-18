# a junction connector between two roads of different types (motorway exit onto a local road)
# takes the lower type, so the motorway colour stops where the motorway does (base3 in place)
import json,math,numpy as np,collections
from shapely.geometry import LineString,Point
from shapely.strtree import STRtree
FULL='/tmp/claude-0/full'
SC=np.array([0.00025048*math.cos(math.radians(45))/math.cos(math.radians(47)),0.000175])
RANK={'local':0,'divided':1,'freeway':2}
base=json.load(open(FULL+'/base3.geojson')); F=base['features']
# type at an end = highest type among the other roads meeting there (any drawn road, so a
# connector ending on other connectors counts too)
R=[];RI=[]
for k,f in enumerate(F):
    p=f['properties']
    if p.get('type')=='road' and p.get('roadType') in RANK and f['geometry']['type']=='LineString' and len(f['geometry']['coordinates'])>1:
        R.append((LineString(np.asarray(f['geometry']['coordinates'])/SC),p['roadType'])); RI.append(k)
t=STRtree([g for g,_ in R]); c=collections.Counter()
orig=[R[i][1] for i in range(len(R))]
for i,k in enumerate(RI):
    p=F[k]['properties']
    if p.get('pf')!=2: continue
    g=R[i][0]; ts=[]
    for e in (g.coords[0],g.coords[-1]):
        o=[orig[j] for j in t.query(Point(e),predicate='dwithin',distance=1.5) if j!=i]
        ts.append(max(o,key=RANK.get) if o else None)
    if None in ts: continue
    low=min(ts,key=RANK.get)
    if RANK[low]<RANK[p['roadType']]: c[(p['roadType'],low)]+=1; p['roadType']=low
print(c)
json.dump(base,open(FULL+'/base3.geojson','w'),separators=(',',':'))
