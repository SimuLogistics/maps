import json, math, sys, time
import numpy as np
import shapely
from shapely.geometry import LineString, shape, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
t0=time.time()
FULL='/tmp/claude-0/full'
P='/mnt/user-data/uploads/Dev/tools/snapshots/ets2/1.61.1.1/.cache/parser'
SX45, SY = 0.00025048, 0.000175
def fwd(c):  # deg -> local metres (approx, scale per latitude)
    # one fixed scale for the whole map: per-feature scales put the same point at different metres
    a=np.asarray(c,dtype=float)
    sx=SX45*math.cos(math.radians(45))/math.cos(math.radians(47))
    return a/np.array([sx,SY]), np.array([sx,SY])
paths={d['token']:d['path'] for d in json.load(open(P+'/europe-prefabDescriptions.json'))}
cur=json.load(open(FULL+'/europe-prefab-curves.geojson'))
base=json.load(open(FULL+'/base.geojson'))
print('loaded',time.time()-t0,flush=True)
# lanes in metres
lane_lines=[];lane_toll=[];lane_uid=[];toll_groups={}
for f in cur['features']:
    tok=f['properties']['prefabToken']; toll='/tollgate/' in paths.get(tok,'')
    for ls in f['geometry']['coordinates']:
        if len(ls)<2: continue
        m,_=fwd(ls); g=LineString(m)
        lane_lines.append(g); lane_toll.append(toll); lane_uid.append(f['properties']['prefabUid'])
        if toll: toll_groups.setdefault(f['properties']['prefabUid'],[]).append(g)
print('lanes',len(lane_lines),'tolls',len(toll_groups),time.time()-t0,flush=True)
# plazas
plazas=[]
for uid,ls in toll_groups.items():
    u=unary_union([l.buffer(2.4,cap_style=2) for l in ls])
    near=[]
    for f in []: pass
    plazas.append(u.buffer(8,join_style=1).buffer(-8,join_style=1))
ptree=STRtree(plazas)
from collections import defaultdict
seen_con=set()
con=json.load(open(FULL+'/connectors.geojson'))
# drawn regular road ends (metres) to snap connector ends onto the carriageway the lanes use
rend=[];rendp=[]
for f in base['features']:
    p=f['properties']
    if p.get('type')=='road' and p.get('pf')==0:
        for c in (f['geometry']['coordinates'][0],f['geometry']['coordinates'][-1]):
            m,_=fwd([c]); rend.append(m[0]); rendp.append(p)
rend=np.array(rend); rtree=STRtree([shapely.Point(q) for q in rend])
sends=[];sendp=[]
for f in base['features']:
    p=f['properties']
    if p.get('type')=='road' and p.get('pf') in (0,1):
        for c in (f['geometry']['coordinates'][0],f['geometry']['coordinates'][-1]):
            m,_=fwd([c]); sends.append(shapely.Point(m[0])); sendp.append(p)
stree=STRtree(sends)
def hermite(p0,r0,p1,r1):
    d=math.dist(p0,p1)
    if d<0.01: return [p0,p1]
    ch=math.atan2(p1[1]-p0[1],p1[0]-p0[0]); w=lambda a:abs(math.atan2(math.sin(a),math.cos(a)))
    n=min(64,max(1,math.ceil((w(r0-ch)+w(r1-ch))/(math.pi/90))))
    m0=np.array([math.cos(r0),math.sin(r0)])*d; m1=np.array([math.cos(r1),math.sin(r1)])*d
    P0=np.array(p0);P1=np.array(p1);out=[]
    for k in range(n+1):
        t=k/n;t2=t*t;t3=t2*t
        out.append(P0*(2*t3-3*t2+1)+m0*(t3-2*t2+t)+P1*(-2*t3+3*t2)+m1*(t3-t2))
    return out
rlines=[];rlinep=[]
for f in base['features']:
    p=f['properties']
    if p.get('type')=='road' and p.get('pf')==0:
        m,_=fwd(f['geometry']['coordinates']); rlines.append(LineString(m)); rlinep.append(p)
rltree=STRtree(rlines)
def snap(node,hint,rot):
    # carriageway the lanes end on: nearest drawn road to the lane hint, projected onto it
    # (roads with a median are drawn off-centre and sometimes overlap into the prefab)
    if math.dist(node,hint)<30:
        H=shapely.Point(hint); k=rltree.query_nearest(H,max_distance=6)
        if len(k):
            g=rlines[k[0]]; q=g.interpolate(g.project(H))
            if math.dist((q.x,q.y),node)<25: return [q.x,q.y],rlinep[k[0]]
    return node,None
def snap_end(node,hint,rot):
    idx=rtree.query(shapely.Point(node),predicate='dwithin',distance=20.0)
    # only road ends lying across the node (same cross-section), not further along the road
    d=np.array([math.cos(rot),math.sin(rot)])
    idx=[k for k in idx if abs(np.dot(rend[k]-node,d))<2.0]
    if len(idx)==0: return node,None
    best=min(idx,key=lambda k:math.dist(rend[k],hint))
    return rend[best].tolist(),rendp[best]
cons=defaultdict(list); con_feat=defaultdict(list); snapped=0
for f in con['features']:
    pr=f['properties']; cs=f['geometry']['coordinates']
    m,sc=fwd(cs+[pr['sh'],pr['eh']]); hs,he=m[-2],m[-1]; m=m[:-2]
    r0=math.atan2(*(m[1]-m[0])[::-1]); r1=math.atan2(*(m[-1]-m[-2])[::-1])
    a,pa=snap(m[0],hs,r0); b,pb=snap(m[-1],he,r1)
    if math.dist(a,m[0])>0.5 or math.dist(b,m[-1])>0.5: snapped+=1
    if math.dist(a,b)<1.0: continue
    g=LineString(hermite(a,r0,b,r1))
    key=(uid:=pr['prefabUid'],tuple(sorted([tuple(np.round(a,1)),tuple(np.round(b,1))])))
    if key in seen_con: continue
    seen_con.add(key)
    src=pa or pb
    if src is None:
        k=stree.query_nearest(shapely.Point(a),max_distance=60)
        if len(k)==0: k=stree.query_nearest(shapely.Point(b),max_distance=60)
        src=sendp[k[0]] if len(k) else {'roadType':'local','leftLanes':1,'rightLanes':1}
    cons[uid].append(g); con_feat[uid].append((src,sc))
print('connectors',sum(map(len,cons.values())),'snapped',snapped,flush=True)
lanes_by=defaultdict(list)
uid_tok={f['properties']['prefabUid']:f['properties']['prefabToken'] for f in cur['features']}
for g,uid,toll in zip(lane_lines,lane_uid,lane_toll):
    if not toll: lanes_by[uid].append(g)
simple=set(); why={}
for uid,ls in lanes_by.items():
    cs=cons.get(uid)
    if not cs:
        why[uid]=[0,-1]; continue
    t=STRtree(cs); ok=True
    # junction templates only hold node-to-node lanes, so wide lane fans (3+ lanes, offsets) still match their curves;
    # service areas (gas, border, depots…) keep the tight rule so their parking lanes stay drawn
    cat=paths.get(uid_tok.get(uid,''),'').split('/')[1:2]
    tol=25.0 if cat and cat[0] in ('fork_temp','cross_temp','round_temp','fork','cross','round') else 9.0
    for g in ls:
        pts=[shapely.Point(c) for c in g.coords]
        hit=np.zeros(len(pts),bool); hit[t.query(pts,predicate='dwithin',distance=tol)[0]]=True
        if not hit.all():
            ok=False
            far=[pts[i] for i in np.where(~hit)[0]]
            why[uid]=[len(cs),max(min(c.distance(q) for c in cs) for q in far)]
            break
    if ok: simple.add(uid)
json.dump({'simple':sorted(simple),'why':why},open(FULL+'/simple.json','w'))
print('connector prefabs',len(simple),'of',len(lanes_by),flush=True)
keep_idx=[i for i,u in enumerate(lane_uid) if u not in simple]
tree=STRtree([lane_lines[i] for i in keep_idx])
ctree=STRtree([g for u in simple for g in cons[u]])
hulls=[unary_union([g.buffer(6) for g in cons[u]]+[g.buffer(5) for g in lanes_by[u]]) for u in simple]
htree=STRtree(hulls)
cend=[np.array(c) for u in simple for g in cons[u] for c in (g.coords[0],g.coords[-1])]
cetree=STRtree([shapely.Point(c) for c in cend])
clines=[g for u in simple for g in cons[u]]
def join(pt):
    P=shapely.Point(pt); k=ctree.query_nearest(P,max_distance=10)
    if not len(k): return pt
    g=clines[k[0]]; q=g.interpolate(g.project(P))
    return [q.x,q.y]
# filter game paths
out=[];kept=dropped=0
for f in base['features']:
    p=f['properties']
    if p.get('type')=='road' and p.get('pf')==1:
        m,s=fwd(f['geometry']['coordinates'])
        m=np.array(LineString(m).segmentize(4.0).coords)
        segs=[LineString(m[i:i+2]) for i in range(len(m)-1)]
        mids=[sg.interpolate(0.5,normalized=True) for sg in segs]
        # segment redundant if its midpoint is within 5 m of a lane, or inside a plaza
        # redundant only if both ends and the middle are within 4 m of AI lanes
        red=np.ones(len(segs),bool); redc=np.ones(len(segs),bool)
        for pts in (mids,[shapely.Point(m[i]) for i in range(len(segs))],[shapely.Point(m[i+1]) for i in range(len(segs))]):
            ok=np.zeros(len(segs),bool); ok[tree.query(pts,predicate='dwithin',distance=4.0)[0]]=True
            red&=ok
            okc=np.zeros(len(segs),bool); okc[ctree.query(pts,predicate='dwithin',distance=7.0)[0]]=True
            redc&=okc
        red|=redc
        inp=ptree.query(mids,predicate='intersects'); red[inp[0]]=True
        inh=htree.query(mids,predicate='within'); red[inh[0]]=True
        # rebuild runs of kept segments
        run=[]
        def flush():
            global kept
            if len(run)>=2 and LineString(run).length>=15:
                run[0]=join(run[0]); run[-1]=join(run[-1])
                g={'type':'LineString','coordinates':(np.array(LineString(run).simplify(0.3).coords)*s).tolist()}
                out.append({'type':'Feature','properties':p,'geometry':g}); kept+=1
        for i,sg in enumerate(segs):
            if red[i]:
                flush(); run=[]
            else:
                if not run: run=[m[i].tolist()]
                run.append(m[i+1].tolist())
        flush()
        if red.any(): dropped+=1
    else:
        out.append(f)
for u in simple:
    for g,(src,sc) in zip(cons[u],con_feat[u]):
        props={'type':'road','pf':2,'roadType':src.get('roadType'),'leftLanes':src.get('leftLanes'),'rightLanes':src.get('rightLanes'),'dlcGuard':src.get('dlcGuard'),'hidden':False,'secret':False}
        out.append({'type':'Feature','properties':props,'geometry':{'type':'LineString','coordinates':(np.array(g.coords)*sc).tolist()}})
# gaps between road ends are closed afterwards by gaps.py (base2 -> base3)
base['features']=out
json.dump(base,open(FULL+'/base2.geojson','w'),separators=(',',':'))
print('paths kept pieces',kept,'features touched',dropped,time.time()-t0,flush=True)
# lanes (non-toll) & plazas back to degrees
def back(g):
    lat=None
    return g
lf=[];pf=[]
for g,toll in zip(lane_lines,lane_toll):
    if toll: continue
lanes_out={'type':'FeatureCollection','features':[]}
for f in cur['features']:
    tok=f['properties']['prefabToken']
    if '/tollgate/' in paths.get(tok,'') or f['properties']['prefabUid'] in simple: continue
    lanes_out['features'].append({'type':'Feature','properties':{},'geometry':f['geometry']})
json.dump(lanes_out,open(FULL+'/lanes2.geojson','w'),separators=(',',':'))
pl={'type':'FeatureCollection','features':[]}
for g in plazas:
    sx=SX45*math.cos(math.radians(45))/math.cos(math.radians(47))
    gd=shapely.transform(g,lambda a:a*np.array([sx,SY]))
    pl['features'].append({'type':'Feature','properties':{'type':'plaza'},'geometry':mapping(gd.simplify(0.0000005))})
json.dump(pl,open(FULL+'/plazas.geojson','w'),separators=(',',':'))
print('done',time.time()-t0)
