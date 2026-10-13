// "<" is escaped so a title containing "</script>" can't end the tag early.
export default function ScriptJsonLd({ data }) {
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
