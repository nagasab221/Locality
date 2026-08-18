import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { get, imgUrl } from "../api";
import type { ListItem } from "../types";
import { Img, PosterCard, SectionTitle } from "../components/ui";

interface PersonData {
  person: {
    tmdbId: number;
    name: string;
    bio: string;
    birthday: string | null;
    deathday: string | null;
    knownFor: string | null;
    placeOfBirth: string | null;
    photo: string | null;
  };
  inLibrary: ListItem[];
}

export default function PersonPage() {
  const { tmdbId } = useParams();
  const [data, setData] = useState<PersonData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    get<PersonData>(`/person/${tmdbId}`)
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, [tmdbId]);

  if (error) return <div className="p-8 text-danger">{error}</div>;
  if (!data) return <div className="p-8 text-muted">Loading…</div>;

  const p = data.person;
  return (
    <div className="p-8">
      <div className="flex gap-7 mb-10">
        <div className="w-44 shrink-0 rounded-lg overflow-hidden border border-cardborder bg-raised aspect-[2/3]">
          <Img src={imgUrl(p.photo)} fallbackText={p.name} className="w-full h-full object-cover" />
        </div>
        <div className="min-w-0 pt-2">
          <h1 className="font-display text-3xl text-heading">{p.name}</h1>
          <div className="mt-1.5 text-sm text-muted flex flex-wrap gap-x-3">
            {p.knownFor && <span>{p.knownFor}</span>}
            {p.birthday && (
              <span>
                b. {p.birthday}
                {p.deathday && `, died ${p.deathday}`}
              </span>
            )}
            {p.placeOfBirth && <span>{p.placeOfBirth}</span>}
          </div>
          {p.bio && <p className="mt-4 text-sm text-body/90 leading-relaxed max-w-3xl whitespace-pre-line">{p.bio}</p>}
        </div>
      </div>

      <SectionTitle>In your library</SectionTitle>
      {data.inLibrary.length === 0 ? (
        <p className="text-sm text-muted">Nothing else in your library features {p.name}.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
          {data.inLibrary.map((it) => (
            <PosterCard key={it.id} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}
