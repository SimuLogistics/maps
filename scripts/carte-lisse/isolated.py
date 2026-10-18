# a short single-lane stretch typed motorway that touches no other motorway (a one-way motorway
# template reused on an ordinary road) is drawn with the type of the roads around it (base3 in place)
import json,math,numpy as np,collections,sys
from shapely.geometry import LineString,Point
from shapely.strtree import STRtree
FULL='/tmp/claude-0/full'; MAXLEN=float(sys.argv[1]) if len(sys.argv)>1 else 1500
SC=np.array([0.00025048*math.cos(math.radians(45))/math.cos(math.radians(47)),0.000175])
base=json.load(open(FULL+'/base3.geojson')); F=base['features']
lan=json.load(open(FULL+'/lanes2.geojson'))['features']
G=[];T=[];idx=[]
for k,f in enumerate(F):
    p=f['properties']
    if p.get('type')!='road' or p.get('roadType')=='train' or f['geometry']['type']!='LineString' or len(f['geometry']['coordinates'])<2: continue
    G.append(LineString(np.asarray(f['geometry']['coordinates'])/SC)); T.append(p.get('roadType')); idx.append(k)
nb=len(G)
for f in lan:
    if len(f['geometry']['coordinates'])>1:
        G.append(LineString(np.asarray(f['geometry']['coordinates'])/SC)); T.append(f['properties'].get('roadType')); idx.append(None)
t=STRtree(G)
fw=[i for i in range(len(G)) if T[i]=='freeway']
par={i:i for i in fw}
def find(a):
    while par[a]!=a: par[a]=par[par[a]]; a=par[a]
    return a
nbr=collections.defaultdict(collections.Counter)
for i in fw:
    for e in (G[i].coords[0],G[i].coords[-1]):
        for j in t.query(Point(e),predicate='dwithin',distance=1.5):
            if j==i: continue
            if T[j]=='freeway': par[find(i)]=find(j)
            else: nbr[i][T[j]]+=1
comp=collections.defaultdict(list)
for i in fw: comp[find(i)].append(i)
dem=0;demlen=0;ex=[]
for r,mem in comp.items():
    L=sum(G[i].length for i in mem)
    if L>=MAXLEN: continue
    # only single-lane pieces (one-way 1-lane motorway templates reused on ordinary roads);
    # a real motorway stretch cut off by a drawing gap has 2+ lanes and stays
    if any(i>=nb or max(F[idx[i]]['properties'].get('leftLanes') or 0,F[idx[i]]['properties'].get('rightLanes') or 0)>1 for i in mem): continue
    cnt=collections.Counter()
    for i in mem: cnt.update(nbr[i])
    if not cnt: continue   # touches nothing (isolated drawing): leave it
    new='divided' if cnt.get('divided',0)>cnt.get('local',0) else 'local'
    for i in mem:
        if i<nb: F[idx[i]]['properties']['roadType']=new; dem+=1
    demlen+=L; ex.append((L,list(G[mem[0]].coords[0]*SC)))
print('freeway components',len(comp),'demoted',sum(1 for _ in ex),'features',dem,'length',int(demlen))
ex.sort(reverse=True); print([(int(l),[round(v,5) for v in c]) for l,c in ex[:8]])
json.dump(base,open(FULL+'/base3.geojson','w'),separators=(',',':'))
if len(sys.argv)>2:
    q=Point(np.array([float(sys.argv[2]),float(sys.argv[3])])/SC)
    k=[i for i in t.query(q,predicate='dwithin',distance=30) if T[i]=='freeway']
    for i in k:
        r=find(i); mem=comp[r]
        print('feat',i,'nb' if i<nb else 'lane','comp size',len(mem),'len',int(sum(G[j].length for j in mem)),'lanes in comp',sum(1 for j in mem if j>=nb))
