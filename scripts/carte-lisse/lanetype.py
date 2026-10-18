# road type of the lanes drawn for prefabs not drawn by connectors (lanes2.geojson):
# a junction prefab whose roads are all motorway (or all divided) keeps that colour;
# anything else (depots, service areas, mixed junctions) is local, except a lane whose
# two ends both meet a motorway/divided road.
import json,math,numpy as np,collections
from shapely.geometry import LineString,Point
from shapely.strtree import STRtree
FULL='/tmp/claude-0/full'
P='/mnt/user-data/uploads/Dev/tools/snapshots/ets2/1.61.1.1/.cache/parser'
paths={d['token']:d['path'] for d in json.load(open(P+'/europe-prefabDescriptions.json'))}
SC=np.array([0.00025048*math.cos(math.radians(45))/math.cos(math.radians(47)),0.000175])
simple=set(json.load(open(FULL+'/simple.json'))['simple'])
b=json.load(open(FULL+'/base3.geojson'))['features']
R=[(LineString(np.asarray(f['geometry']['coordinates'])/SC),f['properties'].get('roadType')) for f in b
   if f['properties'].get('type')=='road' and f['properties'].get('pf') in (0,2,3) and f['properties'].get('roadType')!='train'
   and f['geometry']['type']=='LineString' and len(f['geometry']['coordinates'])>1]
t=STRtree([g for g,_ in R])
def at(p): return {R[i][1] for i in t.query(Point(p),predicate='dwithin',distance=6)}
JUNC=('fork_temp','cross_temp','round_temp','/fork/','/cross/','/round/')
cur=json.load(open(FULL+'/europe-prefab-curves.geojson'))['features']
c=collections.Counter(); out=[]
for f in cur:
    tok=f['properties']['prefabToken']; pa=paths.get(tok,'')
    if '/tollgate/' in pa or f['properties']['prefabUid'] in simple: continue
    lanes=[]
    for pp in f['geometry']['coordinates']:
        if len(pp)<2: continue
        m=np.asarray(pp)/SC; lanes.append((pp,at(m[0]),at(m[-1])))
    touch=set().union(*[a|z for _,a,z in lanes]) if lanes else set()
    junc=any(j in pa for j in JUNC)
    whole=None
    if junc and touch=={'freeway'}: whole='freeway'
    elif junc and touch and touch<={'freeway','divided'}: whole='divided'
    for pp,a,z in lanes:
        rt=whole
        if rt is None:
            rt='local'
            for typ in ('freeway','divided'):
                if typ in a and typ in z: rt=typ; break
        c[(junc,rt)]+=1
        out.append({'type':'Feature','properties':{'roadType':rt},'geometry':{'type':'LineString','coordinates':pp}})
print(c)
json.dump({'type':'FeatureCollection','features':out},open(FULL+'/lanes2.geojson','w'),separators=(',',':'))
