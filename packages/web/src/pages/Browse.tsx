import { Link } from "react-router-dom";
import { useSets } from "../hooks/useSets";

export function Browse() {
  const { data: sets, isLoading } = useSets();

  if (isLoading) return <p>loading...</p>;
  if (!sets?.length) return <p>no sets yet. <Link to="/generate" className="underline">generate some questions</Link></p>;

  return (
    <table className="w-full text-left border-collapse">
      <thead>
        <tr className="border-b border-black">
          <th className="py-1">name</th>
          <th className="py-1">theme</th>
          <th className="py-1">tossups</th>
          <th className="py-1">bonuses</th>
          <th className="py-1">created</th>
        </tr>
      </thead>
      <tbody>
        {sets.map((s) => (
          <tr key={s.id} className="border-b border-gray-300">
            <td className="py-1"><Link to={`/sets/${s.id}`} className="underline">{s.name}</Link></td>
            <td className="py-1">{s.theme}</td>
            <td className="py-1">{s._count?.tossups ?? 0}</td>
            <td className="py-1">{s._count?.bonuses ?? 0}</td>
            <td className="py-1">{new Date(s.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
