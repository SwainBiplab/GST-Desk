CREATE TABLE "hsn_embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	"code" text NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"vector_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hsn_embeddings_code_model_uq" ON "hsn_embeddings" USING btree ("code","model");