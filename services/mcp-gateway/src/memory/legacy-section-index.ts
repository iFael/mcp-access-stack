import { createHash } from "node:crypto";

export interface LegacySource {
  surface:"oracle"|"windows";
  filename:string;
  content:string;
  contentSha256:string;
}
export interface LegacySectionMatch {
  surface:"oracle"|"windows";
  filename:string;
  heading:string;
  sectionIndex:number;
  sourceSha256:string;
  sectionSha256:string;
  excerpt:string;
  provenance:"historical_unverified";
}

function normalize(text:string):string {return text.toLocaleLowerCase("pt-BR");}
function sha(text:string):string {return createHash("sha256").update(text).digest("hex");}
function excerpt(section:string,index:number,matchLength:number):string {
  const MAX=700;
  if(section.length<=MAX)return section.trim();
  const start=Math.max(0,Math.min(index-120,section.length-MAX));
  const clipped=section.slice(start,start+MAX).trim();
  return (start>0?"…":"")+clipped+(start+MAX<section.length?"…":"");
}

/**
 * Search the preserved .codex sources without silently promoting historical
 * content to current operational truth. All returned matches remain explicitly
 * unverified until the agent reconciles them with live authoritative evidence.
 */
export function searchLegacySections(
  sources:readonly LegacySource[],query:string,limit=8,
):LegacySectionMatch[] {
  if(!query.trim()||query.length>200||
    !Number.isInteger(limit)||limit<1||limit>20)throw new Error("MEMORY_LEGACY_QUERY_INVALID");
  const wanted=normalize(query.trim());
  const hits:Array<LegacySectionMatch&{headingHit:boolean}>=[];
  for(const source of sources){
    if(sha(source.content)!==source.contentSha256)
      throw new Error("MEMORY_LEGACY_SOURCE_CORRUPT");
    const boundaries=[...source.content.matchAll(/^##[ \t]+(.+)$/gm)];
    const sections:Array<{heading:string;start:number;end:number}>=[];
    if(boundaries[0]?.index!==0)sections.push({
      heading:"Document preface",start:0,end:boundaries[0]?.index??source.content.length,
    });
    for(let n=0;n<boundaries.length;n++){
      const b=boundaries[n]!;
      sections.push({heading:b[1]!.trim(),start:b.index!,end:boundaries[n+1]?.index??source.content.length});
    }
    for(let n=0;n<sections.length;n++){
      const section=sections[n]!;
      const body=source.content.slice(section.start,section.end);
      const index=normalize(body).indexOf(wanted);
      if(index<0)continue;
      hits.push({
        surface:source.surface,filename:source.filename,heading:section.heading,
        sectionIndex:n,sourceSha256:source.contentSha256,
        sectionSha256:sha(body),excerpt:excerpt(body,index,query.length),
        provenance:"historical_unverified",
        headingHit:normalize(section.heading).includes(wanted),
      });
    }
  }
  hits.sort((a,b)=>Number(b.headingHit)-Number(a.headingHit) ||
    a.filename.localeCompare(b.filename) || a.heading.localeCompare(b.heading) ||
    a.surface.localeCompare(b.surface) || a.sectionIndex-b.sectionIndex);
  return hits.slice(0,limit).map(({headingHit:_headingHit,...hit})=>hit);
}
