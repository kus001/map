import { TORONTO_ORIGIN, toLocalMetres, triangulateRoof } from "./buildingMesh.mjs";

// Streets are actual OpenStreetMap ways. We only draw what the service returns.
const COLORS = ["ground", "park", "sidewalk", "road", "path"];
const FACE_NORMAL = [0, 1, 0];
function triangle(array, a, b, c) {
  for (const p of [a, b, c]) array.push(p[0],p[1],p[2],0,0,...FACE_NORMAL);
}
function quad(array, a, b, c, d) {
  triangle(array,a,b,c);
  triangle(array,a,c,d);
}
function streetStrip(array, a, b, width, height) {
  const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);
  if (length < 0.05 || length > 1400) return;
  const nx=-dz/length * width/2, nz=dx/length * width/2;
  const p=[a[0]+nx,height,a[1]+nz],q=[a[0]-nx,height,a[1]-nz];
  const r=[b[0]-nx,height,b[1]-nz],s=[b[0]+nx,height,b[1]+nz];
  quad(array,p,s,r,q);
}
function cleanPoints(points) {
  const result=[];
  for (const p of points) {
    if (!Array.isArray(p) || p.length<2 || !p.every(Number.isFinite)) continue;
    if (!result.length || Math.hypot(p[0]-result.at(-1)[0],p[1]-result.at(-1)[1])>0.02) result.push(p);
  }
  if (result.length>2 && Math.hypot(result[0][0]-result.at(-1)[0], result[0][1]-result.at(-1)[1])<0.05) result.pop();
  return result;
}
function area(points) {
  let sum=0;
  for (let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length];
    sum+=a[0]*b[1]-a[1]*b[0];
  }
  return sum*0.5;
}
export function parseOSMStreets(json) {
  if (!Array.isArray(json?.elements)) throw new Error("Invalid OSM street data");
  const roads=[],parks=[];
  for (const way of json.elements) {
    if (way.type!=="way" || !Array.isArray(way.geometry)) continue;
    const points=cleanPoints(way.geometry
      .filter(({lat,lon})=>Number.isFinite(lat)&&Number.isFinite(lon))
      .map(({lat,lon})=>toLocalMetres([lon,lat],TORONTO_ORIGIN)));
    const tags=way.tags||{};
    if (tags.highway && points.length>=2) roads.push({id:way.id,points,type:tags.highway});
    if (tags.leisure==="park" && points.length>=3) parks.push({id:way.id,points});
  }
  return { roads, parks };
}
function widthOf(type) {
  if (["motorway", "trunk", "primary"].includes(type)) return 12;
  if (["secondary", "tertiary"].includes(type)) return 9;
  if (["residential", "unclassified", "living_street"].includes(type)) return 7;
  if (["service", "track"].includes(type)) return 4.5;
  return 0;
}
export function createGroundMesh(mode="toronto", data=null) {
  const meshes=new Map(COLORS.map(name=>[name,[]]));
  const ground=meshes.get("ground");
  const half=mode==="toronto"?1250:160;
  quad(ground,[-half,-0.13,-half],[-half,-0.13,half],[half,-0.13,half],[half,-0.13,-half]);
  if (!data || mode!=="toronto") return meshes;
  for (const park of data.parks) {
    const points=area(park.points)<0?[...park.points].reverse():park.points;
    for (const [a,b,c] of triangulateRoof(points)) {
      const coords=[points[a],points[b],points[c]];
      triangle(meshes.get("park"),[coords[0][0],-0.068,coords[0][1]],
        [coords[2][0],-0.068,coords[2][1]],[coords[1][0],-0.068,coords[1][1]]);
    }
  }
  for (const way of data.roads) {
    const width=widthOf(way.type);
    const isFootpath=width===0;
    const target=meshes.get(isFootpath?"path":"road");
    for (let i=1;i<way.points.length;i++) {
      const a=way.points[i-1],b=way.points[i];
      if (!isFootpath) streetStrip(meshes.get("sidewalk"),a,b,width+3.8,-0.054);
      streetStrip(target,a,b,isFootpath?2.2:width,isFootpath?-0.046:-0.043);
    }
  }
  return meshes;
}
