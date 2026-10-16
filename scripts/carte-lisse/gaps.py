# close gaps between road ends left dangling (post-process on base2.geojson)
import json, math, sys, time
import numpy as np, shapely
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
FULL='/tmp/claude-0/full'
SX45, SY = 0.00025048, 0.000175
SC=np.array([SX45*math.cos(math.radians(45))/math.cos(math.radians(47)),SY])
MAXD=float(sys.argv[1]) if len(sys.argv)>1 else 45; ANG=35; TOUCH=1.5
def hermite(p0,r0,p1,r1):
    d=math.dist(p0,p1); ch=math.atan2(p1[1]-p0[1],p1[0]-p0[0]); w=lambda a:abs(math.atan2(math.sin(a),math.cos(a)))
    n=min(64,max(1,math.ceil((w(r0-ch)+w(r1-ch))/(math.pi/90))))
    m0=np.array([math.cos(r0),math.sin(r0)])*d; m1=np.array([math.cos(r1),math.sin(r1)])*d
    P0=np.array(p0);P1=np.array(p1);o=[]
    for k in range(n+1):
        t=k/n;t2=t*t;t3=t2*t
        o.append(P0*(2*t3-3*t2+1)+m0*(t3-2*t2+t)+P1*(-2*t3+3*t2)+m1*(t3-t2))
    return o
base=json.load(open(FULL+'/base2.geojson')); out=base['features']
geoms=[];gf=[];E=[];EF=[]
for k,f in enumerate(out):
    p=f['properties']
    if p.get('type')!='road' or f['geometry']['type']!='LineString': continue
    m=np.asarray(f['geometry']['coordinates'],float)/SC
    if len(m)<2: continue
    geoms.append(LineString(m)); gf.append(k)
    if p.get('roadType')=='train': continue
    for pt,q in ((m[0],m[1]),(m[-1],m[-2])):
        # direction from a point ~3 m back, robust to tiny last segments
        d=pt-q; n=np.linalg.norm(d)
        if n>0: E.append((pt,d/n)); EF.append(k)
ltree=STRtree(geoms)
# an end is dangling when nothing continues ahead of it (a fork node, where several features
# end at the same point and all leave backwards, still counts as one dangling end)
dang=[];seen=set()
for i,(p,d) in enumerate(E):
    probe=Point(p+d*3)
    if any(gf[h]!=EF[i] for h in ltree.query(probe,predicate='dwithin',distance=TOUCH)): continue
    key=(round(p[0]*2),round(p[1]*2),round(math.degrees(math.atan2(d[1],d[0]))/20))
    if key in seen: continue
    seen.add(key); dang.append(i)
dt=STRtree([Point(E[i][0]) for i in dang]); cos=math.cos(math.radians(ANG)); cand=[]
for ai,a in enumerate(dang):
    pa,da=E[a]
    for k in dt.query(Point(pa),predicate='dwithin',distance=MAXD):
        b=dang[k]
        if b<=a or EF[b]==EF[a]: continue
        pb,db=E[b]; v=pb-pa; L=np.linalg.norm(v)
        if L<0.3: continue
        u=v/L
        if np.dot(da,u)<cos or np.dot(db,-u)<cos: continue
        tt=out[EF[a]]['properties'].get('roadType'),out[EF[b]]['properties'].get('roadType')
        cand.append((L,a,b))
cand.sort(); used=set(); added=[]
for L,a,b in cand:
    if a in used or b in used: continue
    used|={a,b}; pa,da=E[a]; pb,db=E[b]
    g=hermite(pa.tolist(),math.atan2(da[1],da[0]),pb.tolist(),math.atan2(-db[1],-db[0]))
    src=out[EF[a]]['properties']
    props={k:src.get(k) for k in ('type','roadType','leftLanes','rightLanes','dlcGuard','hidden','secret')}; props['pf']=3
    added.append({'type':'Feature','properties':props,'geometry':{'type':'LineString','coordinates':(np.array(g)*SC).tolist()}})
out.extend(added)
print('road ends',len(E),'dangling',len(dang),'gaps closed',len(added))
hist=np.histogram([math.dist(*[(np.array(c)/SC) for c in (a['geometry']['coordinates'][0],a['geometry']['coordinates'][-1])]) for a in added],bins=[0,2,5,10,20,30,45])
print(hist)
json.dump(base,open(FULL+'/base3.geojson','w'),separators=(',',':'))
json.dump({'type':'FeatureCollection','features':added},open(FULL+'/gaps.geojson','w'))
